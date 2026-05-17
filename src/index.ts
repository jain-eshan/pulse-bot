import "dotenv/config";
import http from "http";
import {
  makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  isJidUser,
  isLidUser,
} from "@whiskeysockets/baileys";
import { useSupabaseAuthState } from "./lib/supabaseAuthState.js";
import type { Boom } from "@hapi/boom";
import qrcode from "qrcode-terminal";
import QRCode from "qrcode";
import path from "path";
import { log } from "./lib/logger.js";
import { handleDm } from "./handlers/dmCommand.js";
import { handleGroupMessage } from "./handlers/groupMessage.js";

// ── QR HTTP server ──────────────────────────────────────────────────────────
// Railway kills containers that don't bind a port. This server:
//   • Keeps the process alive so Railway doesn't restart it mid-QR
//   • Serves the QR as a scannable page at GET /qr
let currentQrDataUrl: string | null = null;
let botConnected = false;

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;

http.createServer(async (req, res) => {
  if (req.url === "/qr") {
    if (botConnected) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<h2 style='font-family:sans-serif;color:green'>✅ Bot is connected to WhatsApp</h2>");
      return;
    }
    if (!currentQrDataUrl) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(`<html><head><meta http-equiv="refresh" content="3"></head><body style="font-family:sans-serif"><p>⏳ Waiting for QR code… (auto-refreshes)</p></body></html>`);
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!DOCTYPE html><html><head>
      <meta name="viewport" content="width=device-width,initial-scale=1">
      <meta http-equiv="refresh" content="30">
      <title>Pulse Bot — Scan QR</title>
      <style>body{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#111;color:#fff;font-family:sans-serif;}img{width:300px;height:300px;border-radius:12px;background:#fff;padding:16px;}p{opacity:.6;font-size:14px;}</style>
    </head><body>
      <h2>Scan with WhatsApp</h2>
      <img src="${currentQrDataUrl}" alt="QR Code"/>
      <p>Open WhatsApp → Linked Devices → Link a Device → scan above</p>
      <p>Auto-refreshes every 30s</p>
    </body></html>`);
    return;
  }
  // Health check
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(botConnected ? "ok — connected" : "ok — waiting for QR");
}).listen(PORT, () => {
  log.info(`QR server listening on port ${PORT} — visit /qr to scan`);
});
// ────────────────────────────────────────────────────────────────────────────

async function start() {
  // On Railway: persist session to Supabase so restarts don't require re-scanning QR.
  // Locally (no SUPABASE_URL): fall back to local auth/ folder.
  const { state, saveCreds } = process.env.SUPABASE_URL
    ? await useSupabaseAuthState()
    : await useMultiFileAuthState("auth");

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

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      // Terminal QR (local dev)
      qrcode.generate(qr, { small: true });
      // Data URL for the HTTP /qr page (Railway)
      currentQrDataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
      log.info(`QR ready — visit /qr on your Railway URL to scan`);
      // Also save PNG + auto-open on macOS (local dev)
      if (process.platform === "darwin") {
        const qrPath = path.resolve("qr.png");
        await QRCode.toFile(qrPath, qr, { scale: 8, margin: 2 });
        const { exec } = (await import("child_process"));
        exec(`open "${qrPath}"`);
      }
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
      botConnected = true;
      currentQrDataUrl = null;
      log.info("✅ Pulse Bot connected to WhatsApp");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const text =
        msg.message.conversation ??
        msg.message.extendedTextMessage?.text ??
        "";

      if (!text.trim()) continue;

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
