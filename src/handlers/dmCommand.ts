import type { WASocket } from "@whiskeysockets/baileys";
import { supabase } from "../lib/supabase.js";
import { verifyLinkCode } from "../lib/linkVerify.js";
import { log } from "../lib/logger.js";
import { format } from "date-fns";

async function resolveUser(waPhone: string) {
  const { data } = await supabase
    .from("users")
    .select("id, name")
    .eq("wa_phone", waPhone)
    .maybeSingle();
  return data;
}

async function getPending(senderJid: string) {
  const { data } = await supabase
    .from("bot_pending_confirms")
    .select("group_jid, parsed_payload, expires_at")
    .eq("sender_jid", senderJid)
    .maybeSingle();
  if (!data) return null;
  if (new Date(data.expires_at) < new Date()) {
    await supabase.from("bot_pending_confirms").delete().eq("sender_jid", senderJid);
    return null;
  }
  return data;
}

async function clearPending(senderJid: string) {
  await supabase.from("bot_pending_confirms").delete().eq("sender_jid", senderJid);
}

async function cmdYes(sock: WASocket, jid: string, waPhone: string) {
  const pending = await getPending(jid);
  if (!pending) {
    await sock.sendMessage(jid, { text: "Nothing pending. Type *help* to see commands." });
    return;
  }

  const user = await resolveUser(waPhone);
  if (!user) {
    await sock.sendMessage(jid, {
      text: "🔗 You need to link your account first.\n1. Visit pulse.eshanjain.in → Profile\n2. Generate link code\n3. Reply: *link 123456*",
    });
    return;
  }

  const parsed = pending.parsed_payload as { title?: string; description?: string; starts_at?: string; venue?: string; tags?: string[] };
  const { data: session, error } = await supabase
    .from("sessions")
    .insert({
      title: parsed.title || "Untitled",
      description: parsed.description ?? null,
      starts_at: parsed.starts_at,
      venue: parsed.venue ?? null,
      tags: parsed.tags ?? [],
      creator_id: user.id,
      wa_group_jid: pending.group_jid,
    })
    .select()
    .single();

  if (error || !session) {
    log.error({ error }, "failed to publish session from DM yes");
    await sock.sendMessage(jid, { text: "❌ Couldn't publish. Try posting manually at pulse.eshanjain.in" });
    return;
  }

  await clearPending(jid);

  await sock.sendMessage(jid, {
    text: `✅ Published! View at pulse.eshanjain.in/?session=${session.id}`,
  });

  await sock.sendMessage(pending.group_jid, {
    text: `✅ *${session.title}* added to Pulse — RSVP at pulse.eshanjain.in/?session=${session.id}`,
  });
}

async function cmdNo(sock: WASocket, jid: string) {
  const pending = await getPending(jid);
  if (!pending) {
    await sock.sendMessage(jid, { text: "OK 👍" });
    return;
  }
  await clearPending(jid);
  await sock.sendMessage(jid, { text: "Got it, skipped 👍" });
}

async function cmdLink(sock: WASocket, jid: string, waPhone: string, args: string[]) {
  // Accept "link 123456" OR "link 123 456" (user may type with a space)
  const code = args.join("").replace(/\s+/g, "").trim();
  if (!code) {
    await sock.sendMessage(jid, { text: "Please provide your 6-digit code.\nExample: *link 123456*" });
    return;
  }
  const result = await verifyLinkCode(code, waPhone);
  if (result.ok) {
    await sock.sendMessage(jid, {
      text: "✅ Your WhatsApp is now linked to Pulse!\n\nType *sessions* to see what's happening this week.",
    });
  } else {
    await sock.sendMessage(jid, { text: `❌ ${result.reason}` });
  }
}

async function cmdSessions(sock: WASocket, jid: string) {
  const { data } = await supabase
    .from("sessions")
    .select("id, title, starts_at, venue")
    .eq("archived", false)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(5);

  if (!data?.length) {
    await sock.sendMessage(jid, { text: "📭 No upcoming sessions right now.\n\nGo to pulse.eshanjain.in to post one!" });
    return;
  }

  const lines = data.map((s, i) => {
    const when = format(new Date(s.starts_at), "EEE d MMM · h:mm a");
    const where = s.venue ? ` · ${s.venue}` : "";
    return `${i + 1}. *${s.title}*\n   ${when}${where}`;
  });

  await sock.sendMessage(jid, {
    text: `📅 *Upcoming sessions*\n\n${lines.join("\n\n")}\n\nReply *going <number>* to RSVP.`,
  });
}

async function cmdGoing(
  sock: WASocket,
  jid: string,
  userId: string,
  args: string[]
) {
  const idx = parseInt(args[0] ?? "", 10);
  if (!idx || idx < 1 || idx > 5) {
    await sock.sendMessage(jid, { text: "Usage: *going <session number>*\nExample: *going 2*" });
    return;
  }

  const { data } = await supabase
    .from("sessions")
    .select("id, title")
    .eq("archived", false)
    .gte("starts_at", new Date().toISOString())
    .order("starts_at", { ascending: true })
    .limit(5);

  const session = data?.[idx - 1];
  if (!session) {
    await sock.sendMessage(jid, { text: "Session not found. Type *sessions* to see the current list." });
    return;
  }

  await supabase.from("rsvps").upsert({
    session_id: session.id,
    user_id: userId,
    status: "going",
    responded_via: "bot_dm",
  });

  await sock.sendMessage(jid, {
    text: `✅ You're going to *${session.title}*!\n\nSee who else is coming at pulse.eshanjain.in`,
  });
}

function helpText() {
  return [
    "👋 *Pulse Bot — ISB Mohali*",
    "",
    "Commands:",
    "• *link <code>* — Connect your Pulse account",
    "• *sessions* — See upcoming sessions",
    "• *going <number>* — RSVP to a session",
    "• *yes / no* — Confirm an event detected from a group",
    "• *help* — Show this message",
    "",
    "Get your link code at pulse.eshanjain.in → Profile",
  ].join("\n");
}

export async function handleDm(
  sock: WASocket,
  jid: string,
  waPhone: string,
  text: string
) {
  const [cmd, ...args] = text.trim().toLowerCase().split(/\s+/);
  log.info({ waPhone, cmd }, "DM command received");

  if (cmd === "link") {
    await cmdLink(sock, jid, waPhone, args);
    return;
  }

  // YES / NO are quick replies for pending event confirms — no link required for NO
  if (cmd === "yes" || cmd === "y") {
    await cmdYes(sock, jid, waPhone);
    return;
  }
  if (cmd === "no" || cmd === "n") {
    await cmdNo(sock, jid);
    return;
  }

  // All other commands require a linked account
  const user = await resolveUser(waPhone);
  if (!user) {
    await sock.sendMessage(jid, {
      text: "🔗 Link your account first:\n1. Go to pulse.eshanjain.in → Profile\n2. Copy your 6-digit code\n3. Reply: *link <code>*",
    });
    return;
  }

  switch (cmd) {
    case "sessions":
      await cmdSessions(sock, jid);
      break;
    case "going":
      await cmdGoing(sock, jid, user.id, args);
      break;
    case "hi":
    case "hello":
    case "help":
    default:
      await sock.sendMessage(jid, { text: helpText() });
  }
}
