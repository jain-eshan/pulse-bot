import { createHash } from "node:crypto";
import { supabase } from "./supabase.js";

export function hashCode(code: string): string {
  return createHash("sha256").update(code.trim()).digest("hex");
}

export async function verifyLinkCode(
  code: string,
  waPhone: string
): Promise<{ ok: true; userId: string } | { ok: false; reason: string }> {
  const h = hashCode(code);

  const { data } = await supabase
    .from("wa_links")
    .select("user_id, code_expires_at, verified_at")
    .eq("onetime_code_hash", h)
    .single();

  if (!data) return { ok: false, reason: "Code not recognised." };
  if (data.verified_at) return { ok: false, reason: "This code has already been used." };
  if (new Date(data.code_expires_at) < new Date()) {
    return { ok: false, reason: "Code expired — generate a new one from Pulse." };
  }

  await supabase
    .from("wa_links")
    .update({
      wa_phone: waPhone,
      verified_at: new Date().toISOString(),
      onetime_code_hash: null,
      code_expires_at: null,
    })
    .eq("user_id", data.user_id);

  await supabase
    .from("users")
    .update({ wa_phone: waPhone })
    .eq("id", data.user_id);

  return { ok: true, userId: data.user_id };
}
