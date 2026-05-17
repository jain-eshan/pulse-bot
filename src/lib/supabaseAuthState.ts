/**
 * useSupabaseAuthState — persists Baileys WhatsApp session to Supabase.
 *
 * Why: Railway containers have ephemeral storage. Every restart wipes
 * the local auth/ folder, forcing a QR re-scan. By storing session keys
 * in Supabase, the bot reconnects automatically after any restart.
 *
 * Table required:
 *   bot_auth_state (key text primary key, value jsonb not null)
 */

import { initAuthCreds, BufferJSON, proto } from "@whiskeysockets/baileys";
import type { AuthenticationState, SignalDataTypeMap } from "@whiskeysockets/baileys";
import { supabase } from "./supabase.js";
import { log } from "./logger.js";

const TABLE = "bot_auth_state";

async function readData(key: string): Promise<unknown | null> {
  const { data, error } = await supabase
    .from(TABLE)
    .select("value")
    .eq("key", key)
    .maybeSingle();

  if (error) {
    log.warn({ key, error }, "supabaseAuthState: read error");
    return null;
  }
  return data?.value ?? null;
}

async function writeData(key: string, value: unknown): Promise<void> {
  const { error } = await supabase.from(TABLE).upsert({ key, value });
  if (error) log.warn({ key, error }, "supabaseAuthState: write error");
}

async function removeData(key: string): Promise<void> {
  await supabase.from(TABLE).delete().eq("key", key);
}

export async function useSupabaseAuthState(): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> {
  // Load or init credentials
  const storedCreds = await readData("creds");
  const creds: AuthenticationState["creds"] = storedCreds
    ? JSON.parse(JSON.stringify(storedCreds), BufferJSON.reviver)
    : initAuthCreds();

  const keys: Partial<Record<keyof SignalDataTypeMap, Record<string, unknown>>> = {};

  const state: AuthenticationState = {
    creds,
    keys: {
      get: async (type, ids) => {
        const data: Record<string, unknown> = {};
        await Promise.all(
          ids.map(async (id) => {
            const key = `${type}-${id}`;
            let value = keys[type]?.[id];
            if (!value) {
              value = await readData(key);
              if (value) {
                // Cache locally for this session
                keys[type] = keys[type] ?? {};
                (keys[type] as Record<string, unknown>)[id] =
                  JSON.parse(JSON.stringify(value), BufferJSON.reviver);
                value = (keys[type] as Record<string, unknown>)[id];
              }
            }
            data[id] = value ?? null;
          })
        );
        return data as ReturnType<AuthenticationState["keys"]["get"]> extends Promise<infer T> ? T : never;
      },

      set: async (keyData) => {
        const tasks: Promise<void>[] = [];
        for (const [type, typeData] of Object.entries(keyData) as [keyof SignalDataTypeMap, Record<string, unknown>][]) {
          for (const [id, value] of Object.entries(typeData)) {
            const key = `${type}-${id}`;
            // Update local cache
            keys[type] = keys[type] ?? {};
            (keys[type] as Record<string, unknown>)[id] = value;

            if (value) {
              tasks.push(
                writeData(key, JSON.parse(JSON.stringify(value, BufferJSON.replacer)))
              );
            } else {
              tasks.push(removeData(key));
            }
          }
        }
        await Promise.all(tasks);
      },
    },
  };

  const saveCreds = async () => {
    await writeData("creds", JSON.parse(JSON.stringify(creds, BufferJSON.replacer)));
  };

  return { state, saveCreds };
}
