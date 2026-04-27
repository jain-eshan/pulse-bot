/**
 * Runs once — sends a WhatsApp DM to every user who RSVPed "going"
 * for any session starting within the next 60 minutes.
 *
 * Invoke via: npm run cron:reminders
 * On Railway: schedule as a cron job every 30 min.
 */
import "dotenv/config";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";
import { supabase } from "../lib/supabase.js";
import { log } from "../lib/logger.js";
import { format } from "date-fns";

async function sendReminders() {
  const now = new Date();
  const in60 = new Date(now.getTime() + 60 * 60 * 1000);

  const { data: sessions } = await supabase
    .from("sessions")
    .select("id, title, starts_at, venue")
    .eq("archived", false)
    .gte("starts_at", now.toISOString())
    .lte("starts_at", in60.toISOString());

  if (!sessions?.length) {
    log.info("No sessions in the next 60 minutes — nothing to remind");
    return;
  }

  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();
  const sock = makeWASocket({ version, auth: state, printQRInTerminal: false, logger: log.child({ module: "baileys" }) as any });
  sock.ev.on("creds.update", saveCreds);

  // Wait briefly for connection
  await new Promise<void>((resolve) => {
    sock.ev.on("connection.update", ({ connection }) => {
      if (connection === "open") resolve();
    });
    setTimeout(resolve, 8000); // proceed anyway after 8s
  });

  for (const session of sessions) {
    const { data: rsvps } = await supabase
      .from("rsvps")
      .select("user_id, users!inner(wa_phone, name)")
      .eq("session_id", session.id)
      .eq("status", "going");

    const when = format(new Date(session.starts_at), "h:mm a");
    const where = session.venue ? ` in ${session.venue}` : "";

    for (const r of rsvps ?? []) {
      const phone = (r as any).users?.wa_phone;
      if (!phone) continue;
      const jid = `${phone}@s.whatsapp.net`;
      try {
        await sock.sendMessage(jid, {
          text: `⏰ Reminder: *${session.title}* starts at ${when} IST${where}. See you there!`,
        });
        log.info({ phone, sessionId: session.id }, "Reminder sent");
      } catch (err) {
        log.warn({ err, phone }, "Failed to send reminder");
      }
    }
  }

  await sock.logout().catch(() => {});
  process.exit(0);
}

sendReminders().catch((err) => {
  log.error(err, "Reminder cron failed");
  process.exit(1);
});
