import type { WASocket, proto } from "@whiskeysockets/baileys";
import { supabase } from "../lib/supabase.js";
import { looksLikeSessionAnnouncement } from "../lib/parser.js";
import { parseSession, type ParsedSession } from "../lib/claude.js";
import { log } from "../lib/logger.js";

export async function handleGroupMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo
) {
  const groupJid = msg.key.remoteJid!;
  const senderJid = msg.key.participant ?? msg.key.remoteJid!;
  const text =
    msg.message?.conversation ??
    msg.message?.extendedTextMessage?.text ??
    "";

  if (!text) return;
  if (!looksLikeSessionAnnouncement(text)) return;

  log.info({ groupJid, senderJid, preview: text.slice(0, 80) }, "📅 announcement detected");

  // 1. React 📅 in the group (silent visual signal)
  try {
    await sock.sendMessage(groupJid, {
      react: { text: "📅", key: msg.key },
    });
  } catch (err) {
    log.warn({ err }, "failed to react with 📅");
  }

  // 2. Parse with Claude
  const parsed = await parseSession(text);
  if (!parsed) {
    log.info("parse-session returned null — skipping DM");
    return;
  }

  // 3. Store pending confirmation (5 min TTL)
  await supabase.from("bot_pending_confirms").upsert({
    sender_jid: senderJid,
    group_jid: groupJid,
    source_text: text,
    parsed_payload: parsed,
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  });

  // 4. Look up sender — linked or not?
  const senderId = senderJid.replace("@s.whatsapp.net", "").replace("@lid", "");
  const { data: linkedUser } = await supabase
    .from("users")
    .select("id, name")
    .eq("wa_phone", senderId)
    .maybeSingle();

  if (linkedUser) {
    // Linked path
    await sock.sendMessage(senderJid, {
      text: buildLinkedPreview(parsed, linkedUser.name ?? "there"),
    });
  } else {
    // Unlinked: pitch once, never again
    const { data: alreadyPitched } = await supabase
      .from("bot_dm_pitches")
      .select("jid")
      .eq("jid", senderJid)
      .maybeSingle();

    if (alreadyPitched) {
      log.info({ senderJid }, "already pitched — skipping unlinked DM");
      return;
    }

    await supabase.from("bot_dm_pitches").insert({
      jid: senderJid,
      source_group_jid: groupJid,
      parsed_text: text.slice(0, 500),
    });

    await sock.sendMessage(senderJid, {
      text: buildUnlinkedPitch(parsed),
    });
  }
}

function buildLinkedPreview(parsed: ParsedSession, name: string): string {
  return [
    `Hi ${name.split(" ")[0]}! 📅`,
    "",
    "Saw your message in the group. Want me to add it to Pulse?",
    "",
    `*${parsed.title || "(no title)"}*`,
    parsed.starts_at ? `🕐 ${parsed.starts_at}` : null,
    parsed.venue ? `📍 ${parsed.venue}` : null,
    "",
    "Reply *YES* to publish, *NO* to skip.",
  ].filter(Boolean).join("\n");
}

function buildUnlinkedPitch(parsed: ParsedSession): string {
  return [
    "Hi! 👋 I'm Pulse Bot.",
    "",
    "Your cohort uses me to track sessions. I noticed your message looks like an event:",
    "",
    `*${parsed.title || "(no title)"}*`,
    parsed.venue ? `📍 ${parsed.venue}` : null,
    "",
    "Want me to publish it?",
    "",
    "1. Visit pulse.eshanjain.in → Profile",
    "2. Tap *Generate link code*",
    "3. Reply here: `link 123456`",
    "",
    "Then reply *YES* and I'll publish it.",
  ].filter(Boolean).join("\n");
}
