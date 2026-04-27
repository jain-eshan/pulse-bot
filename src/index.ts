import "dotenv/config";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidUser,
  isLidUser,
} from "@whiskeysockets/baileys";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import { log } from "./lib/logger.js";
import { handleDm } from "./handlers/dmCommand.js";
import { handleGroupMessage } from "./handlers/groupMessage.js";

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState("auth");
  const { version } = await fetchLatestBaileysVersion();

  log.info({ version }, "Starting Pulse Bot");

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: false,
    logger: log.child({ module: "baileys" }) as any,
    // Disable per-query timeout — prevents fetchProps from killing init
    defaultQueryTimeoutMs: undefined,
    // Keep socket alive aggressively
    keepAliveIntervalMs: 15_000,
  });

  sock.ev.on("creds.update", saveCreds);

  // Debug: log every event type so we can see what Baileys is emitting
  sock.ev.on("messages.upsert", ({ type }) => {
    log.info({ type }, "🔔 messages.upsert raw event");
  });

  sock.ev.on("connection.update", ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      qrcode.generate(qr, { small: true });
      log.info("Scan the QR code above with WhatsApp");
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      log.warn({ statusCode, shouldReconnect }, "Connection closed");
      if (shouldReconnect) {
        setTimeout(start, 5000);
      } else {
        log.error("Logged out — delete auth/ folder and restart to re-scan QR");
        process.exit(1);
      }
    }

    if (connection === "open") {
      log.info("✅ Pulse Bot connected to WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid ?? "unknown";
      log.info(
        { jid, fromMe: msg.key.fromMe, hasMsg: !!msg.message },
        "🔍 processing message"
      );

      if (msg.key.fromMe) { log.info({ jid }, "⏭ skipped: fromMe"); continue; }
      if (!msg.message)   { log.info({ jid }, "⏭ skipped: no message body"); continue; }

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!text.trim()) { log.info({ jid }, "⏭ skipped: empty text"); continue; }

      try {
        if (isJidUser(jid) || isLidUser(jid)) {
          // Extract identifier: phone number for @s.whatsapp.net, lid for @lid
          const waPhone = isLidUser(jid)
            ? jid.replace("@lid", "")
            : jid.replace("@s.whatsapp.net", "").replace(/\D/g, "");
          log.info({ jid, waPhone, text: text.slice(0, 80) }, "📨 DM received");
          await handleDm(sock, jid, waPhone, text);
        } else {
          await handleGroupMessage(sock, msg);
        }
      } catch (err) {
        log.error({ err, jid }, "Error handling message");
      }
    }
  });
}

start().catch((err) => {
  log.error(err, "Fatal error — bot crashed");
  process.exit(1);
});
