import type { WASocket, proto } from "@whiskeysockets/baileys";
import { downloadMediaMessage } from "@whiskeysockets/baileys";
import { supabase } from "../lib/supabase.js";
import { looksLikeSessionAnnouncement } from "../lib/parser.js";
import { parseSession, type ParsedSession } from "../lib/claude.js";
import { log } from "../lib/logger.js";
import { isTextDuplicate, isSenderOnCooldown, findSemanticDuplicate } from "../lib/dedup.js";
import crypto from "crypto";

const APP_URL = "https://pulse-isb.vercel.app";
const TTL_MS = 15 * 60 * 1000; // 15 minutes

// ── Image helpers ────────────────────────────────────────────────────────────

async function extractImageUrl(
  sock: WASocket,
  msg: proto.IWebMessageInfo
): Promise<string | null> {
  const imageMsg =
    msg.message?.imageMessage ??
    msg.message?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage;

  if (!imageMsg) return null;

  try {
    const buffer = await downloadMediaMessage(
      msg,
      "buffer",
      {},
      { logger: log.child({ module: "download" }) as any, reuploadRequest: sock.updateMediaMessage }
    ) as Buffer;

    const filename = `wa-covers/${Date.now()}-${crypto.randomBytes(4).toString("hex")}.jpg`;
    const { data, error } = await supabase.storage
      .from("session-covers")
      .upload(filename, buffer, { contentType: "image/jpeg", upsert: false });

    if (error || !data) {
      log.warn({ error }, "Failed to upload WA image to Supabase Storage");
      return null;
    }

    const { data: urlData } = supabase.storage.from("session-covers").getPublicUrl(data.path);
    return urlData.publicUrl;
  } catch (err) {
    log.warn({ err }, "Image download/upload failed");
    return null;
  }
}

// ── Magic link for unlinked users ────────────────────────────────────────────

async function createDraftLink(
  parsed: ParsedSession,
  imageUrl: string | null,
  senderJid: string
): Promise<string> {
  const token = crypto.randomBytes(16).toString("hex");
  await supabase.from("bot_event_drafts").insert({
    token,
    sender_jid: senderJid,
    parsed_payload: { ...parsed, image_url: imageUrl ?? undefined },
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
  });
  return `${APP_URL}/?draft=${token}`;
}

// ── Main handler ─────────────────────────────────────────────────────────────

export async function handleGroupMessage(
  sock: WASocket,
  msg: proto.IWebMessageInfo
) {
  const groupJid = msg.key.remoteJid!;
  const senderJid = msg.key.participant ?? msg.key.remoteJid!;
  const m = msg.message;
  const text =
    m?.conversation ??
    m?.extendedTextMessage?.text ??
    m?.imageMessage?.caption ??
    m?.videoMessage?.caption ??
    m?.documentMessage?.caption ??
    m?.ephemeralMessage?.message?.conversation ??
    m?.ephemeralMessage?.message?.extendedTextMessage?.text ??
    m?.ephemeralMessage?.message?.imageMessage?.caption ??
    m?.viewOnceMessage?.message?.conversation ??
    m?.viewOnceMessage?.message?.extendedTextMessage?.text ??
    m?.viewOnceMessage?.message?.imageMessage?.caption ??
    "";

  // Allow image-only messages (caption may be empty) — check for image presence too
  const hasImage = !!(
    m?.imageMessage ??
    m?.extendedTextMessage?.contextInfo?.quotedMessage?.imageMessage
  );

  if (!text && !hasImage) return;
  if (text && !looksLikeSessionAnnouncement(text)) return;

  log.info({ groupJid, senderJid, preview: text.slice(0, 80) }, "📅 announcement detected");

  // ── Dedup Layer 1: Text fingerprint (skip if same text seen in 6h) ────────
  if (text && isTextDuplicate(text)) return;

  // ── Dedup Layer 2: Sender cooldown (skip if same sender triggered in 5m) ──
  if (isSenderOnCooldown(senderJid)) return;

  // 1. React 📅 in the group (silent visual signal)
  try {
    await sock.sendMessage(groupJid, {
      react: { text: "📅", key: msg.key },
    });
  } catch (err) {
    log.warn({ err }, "failed to react with 📅");
  }

  // 2. Download image if present (do in parallel with parse)
  const [parsed, imageUrl] = await Promise.all([
    parseSession(text),
    extractImageUrl(sock, msg),
  ]);

  if (!parsed) {
    log.info("parse-session returned null — skipping DM");
    return;
  }

  // ── Dedup Layer 3: Semantic match (skip if similar event already exists) ──
  const existingId = await findSemanticDuplicate(parsed.title, parsed.starts_at);
  if (existingId) {
    log.info({ existingId, title: parsed.title }, "🔄 dedup: event already exists — skipping DM");
    return;
  }

  if (imageUrl) {
    parsed.image_url = imageUrl;
  }

  // 3. Look up sender — linked or not?
  const senderId = senderJid
    .replace("@s.whatsapp.net", "")
    .replace("@lid", "")
    .replace(/\D/g, "");

  const { data: linkedUser } = await supabase
    .from("users")
    .select("id, name")
    .eq("wa_phone", senderId)
    .maybeSingle();

  if (linkedUser) {
    // ── Linked path: store pending confirm, DM preview ──────────────────────
    await supabase.from("bot_pending_confirms").upsert({
      sender_jid: senderJid,
      group_jid: groupJid,
      source_text: text,
      parsed_payload: { ...parsed, image_url: imageUrl ?? undefined },
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    });

    const firstName = (linkedUser.name ?? "there").split(" ")[0];
    await sock.sendMessage(senderJid, {
      text: buildLinkedPreview(parsed, firstName),
    });
  } else {
    // ── Unlinked path: magic link (pitch once per JID) ───────────────────────
    const { data: alreadyPitched } = await supabase
      .from("bot_dm_pitches")
      .select("jid")
      .eq("jid", senderJid)
      .maybeSingle();

    if (alreadyPitched) {
      log.info({ senderJid }, "already pitched — skipping unlinked DM");
      return;
    }

    // Store the draft so the web app can pre-fill the form
    const draftUrl = await createDraftLink(parsed, imageUrl, senderJid);

    await supabase.from("bot_dm_pitches").insert({
      jid: senderJid,
      source_group_jid: groupJid,
      parsed_text: text.slice(0, 500),
    });

    await sock.sendMessage(senderJid, {
      text: buildUnlinkedPitch(parsed, draftUrl),
    });
  }
}

// ── Message builders ─────────────────────────────────────────────────────────

function fmtTime(isoStr: string): string {
  try {
    return new Date(isoStr).toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return isoStr;
  }
}

function buildLinkedPreview(parsed: ParsedSession, firstName: string): string {
  const lines = [
    `Hey ${firstName}! 🎉 Spotted your event in the group.`,
    "",
    `*${parsed.title}*`,
    parsed.starts_at ? `🕐 ${fmtTime(parsed.starts_at)}` : null,
    parsed.venue ? `📍 ${parsed.venue}` : null,
    parsed.description ? `\n_${parsed.description}_` : null,
    "",
    "I can publish this to Pulse so everyone can RSVP — takes 2 seconds.",
    "Reply *YES* to post it, *NO* to skip.",
  ];
  return lines.filter(Boolean).join("\n");
}

function buildUnlinkedPitch(parsed: ParsedSession, draftUrl: string): string {
  const lines = [
    "Hey! 👋 I'm Pulse, the campus events bot for ISB Mohali.",
    "",
    "Noticed your message in the group — sounds like an event!",
    "",
    `*${parsed.title}*`,
    parsed.starts_at ? `🕐 ${fmtTime(parsed.starts_at)}` : null,
    parsed.venue ? `📍 ${parsed.venue}` : null,
    "",
    "Want to list it on Pulse so your cohort can RSVP? I've already filled in the details for you — just tap the link, sign in, and hit Publish:",
    "",
    draftUrl,
    "",
    "Takes 30 seconds. Your event, your cohort — sorted. 🚀",
  ];
  return lines.filter(Boolean).join("\n");
}
