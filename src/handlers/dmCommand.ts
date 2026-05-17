import type { WASocket } from "@whiskeysockets/baileys";
import { supabase } from "../lib/supabase.js";
import { verifyLinkCode } from "../lib/linkVerify.js";
import { log } from "../lib/logger.js";
import { format } from "date-fns";

const APP_URL = "https://pulse-isb.vercel.app";

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
    await sock.sendMessage(jid, {
      text: "Nothing pending right now! Send *sessions* to see what's on, or post an event at " + APP_URL,
    });
    return;
  }

  const user = await resolveUser(waPhone);
  if (!user) {
    await sock.sendMessage(jid, {
      text: `🔗 You need to link your Pulse account first.\n\nHead to ${APP_URL} → Profile → Generate link code, then reply: *link <your code>*`,
    });
    return;
  }

  const parsed = pending.parsed_payload as {
    title?: string;
    description?: string;
    starts_at?: string;
    ends_at?: string;
    venue?: string;
    category?: string;
    subcategory?: string;
    tags?: string[];
    image_url?: string;
  };

  const { data: session, error } = await supabase
    .from("sessions")
    .insert({
      title: parsed.title || "Untitled",
      description: parsed.description ?? null,
      starts_at: parsed.starts_at,
      ends_at: parsed.ends_at ?? null,
      venue: parsed.venue ?? null,
      category: parsed.category ?? null,
      subcategory: parsed.subcategory ?? null,
      tags: parsed.tags ?? [],
      cover_image_url: parsed.image_url ?? null,
      creator_id: user.id,
      wa_group_jid: pending.group_jid,
    })
    .select()
    .single();

  if (error || !session) {
    log.error({ error }, "failed to publish session from DM yes");
    await sock.sendMessage(jid, {
      text: `❌ Something went wrong. You can post it manually at ${APP_URL} — all the details are saved.`,
    });
    return;
  }

  await clearPending(jid);

  const sessionUrl = `${APP_URL}/?session=${session.id}`;

  await sock.sendMessage(jid, {
    text: `🎉 *${session.title}* is live on Pulse!\n\nShare the link with your cohort:\n${sessionUrl}`,
  });

  await sock.sendMessage(pending.group_jid, {
    text: `📅 *${session.title}* is now on Pulse — RSVP here:\n${sessionUrl}`,
  });
}

async function cmdNo(sock: WASocket, jid: string) {
  const pending = await getPending(jid);
  if (!pending) {
    await sock.sendMessage(jid, { text: "All good! Type *help* if you need anything." });
    return;
  }
  await clearPending(jid);
  await sock.sendMessage(jid, { text: "No worries, skipped! 👍\n\nChange your mind? Post it anytime at " + APP_URL });
}

async function cmdLink(sock: WASocket, jid: string, waPhone: string, args: string[]) {
  const code = args.join("").replace(/\s+/g, "").trim();
  if (!code) {
    await sock.sendMessage(jid, {
      text: `Please include your 6-digit code.\nExample: *link 123456*\n\nGet your code at ${APP_URL} → Profile`,
    });
    return;
  }
  const result = await verifyLinkCode(code, waPhone);
  if (result.ok) {
    await sock.sendMessage(jid, {
      text: `✅ Linked! Your WhatsApp is now connected to Pulse.\n\nType *sessions* to see what's happening on campus, or *help* for all commands.`,
    });
  } else {
    await sock.sendMessage(jid, {
      text: `❌ ${result.reason}\n\nGet a fresh code at ${APP_URL} → Profile`,
    });
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
    await sock.sendMessage(jid, {
      text: `📭 Nothing coming up yet — be the first to post!\n\n${APP_URL}`,
    });
    return;
  }

  const lines = data.map((s, i) => {
    const when = format(new Date(s.starts_at), "EEE d MMM · h:mm a");
    const where = s.venue ? ` · ${s.venue}` : "";
    return `${i + 1}. *${s.title}*\n   ${when}${where}`;
  });

  await sock.sendMessage(jid, {
    text: `📅 *What's happening on campus*\n\n${lines.join("\n\n")}\n\nReply *going <number>* to RSVP.`,
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
    await sock.sendMessage(jid, { text: "Which one? Reply *going <number>* — e.g. *going 2*" });
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
    await sock.sendMessage(jid, { text: "Couldn't find that one. Type *sessions* for the latest list." });
    return;
  }

  await supabase.from("rsvps").upsert({
    session_id: session.id,
    user_id: userId,
    status: "going",
    responded_via: "bot_dm",
  });

  await sock.sendMessage(jid, {
    text: `✅ You're in for *${session.title}*! See who else is coming:\n${APP_URL}/?session=${session.id}`,
  });
}

function helpText() {
  return [
    "👋 *Pulse — ISB Mohali's event platform*",
    "",
    "What I can do:",
    "• *sessions* — See what's happening on campus",
    "• *going <number>* — RSVP to a session",
    "• *yes / no* — Confirm an event I detected in a group",
    "• *link <code>* — Connect your Pulse account",
    "• *help* — Show this",
    "",
    `See everything at ${APP_URL}`,
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
      text: `🔗 Link your account to get started!\n\n1. Go to ${APP_URL} → Profile\n2. Copy your 6-digit code\n3. Reply: *link <code>*`,
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
