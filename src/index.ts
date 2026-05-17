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

// ── State ────────────────────────────────────────────────────────────────────
let currentQrDataUrl: string | null = null;
let botConnected = false;
let lastEventAt: number = Date.now(); // tracks last WA activity (message or ping)
let reconnectAttempts = 0;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
// Watchdog: if connected but no WA activity for 5 min, assume zombie → reconnect
const WATCHDOG_INTERVAL_MS = 60_000;       // check every 60s
const ZOMBIE_THRESHOLD_MS  = 5 * 60_000;  // 5 min silence = zombie

// ── HTTP server ───────────────────────────────────────────────────────────────
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

  if (req.url === "/status") {
    const silenceSecs = Math.round((Date.now() - lastEventAt) / 1000);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      connected: botConnected,
      lastEventSecsAgo: silenceSecs,
      reconnectAttempts,
    }));
    return;
  }

  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(botConnected ? "ok — connected" : "ok — waiting for QR");
}).listen(PORT, () => {
  log.info(`HTTP server on port ${PORT} — /qr to scan, /status for diagnostics`);
});

// ── Reconnect helpers ─────────────────────────────────────────────────────────
function scheduleReconnect(delaySecs: number) {
  log.info({ delaySecs, reconnectAttempts }, `Reconnecting in ${delaySecs}s…`);
  setTimeout(() => { reconnectAttempts++; start(); }, delaySecs * 1000);
}

function startWatchdog(sock: ReturnType<typeof makeWASocket>) {
  if (watchdogTimer) clearInterval(watchdogTimer);
  watchdogTimer = setInterval(() => {
    if (!botConnected) return;
    const silenceMs = Date.now() - lastEventAt;
    if (silenceMs > ZOMBIE_THRESHOLD_MS) {
      log.warn({ silenceSecs: Math.round(silenceMs / 1000) }, "⚠️ Zombie connection detected — forcing reconnect");
      botConnected = false;
      try { sock.end(undefined); } catch { /* ignore */ }
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      scheduleReconnect(5);
    }
  }, WATCHDOG_INTERVAL_MS);
}

// ── Main bot ──────────────────────────────────────────────────────────────────
async function start() {
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
    defaultQueryTimeoutMs: undefined,
    keepAliveIntervalMs: 15_000,
  });

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", async ({ connection, lastDisconnect, qr }) => {
    lastEventAt = Date.now(); // any connection event counts as activity

    if (qr) {
      qrcode.generate(qr, { small: true });
      currentQrDataUrl = await QRCode.toDataURL(qr, { scale: 8, margin: 2 });
      log.info("QR ready — visit /qr on your Railway URL to scan");
      if (process.platform === "darwin") {
        const qrPath = path.resolve("qr.png");
        await QRCode.toFile(qrPath, qr, { scale: 8, margin: 2 });
        const { exec } = (await import("child_process"));
        exec(`open "${qrPath}"`);
      }
    }

    if (connection === "open") {
      botConnected = true;
      currentQrDataUrl = null;
      reconnectAttempts = 0;
      lastEventAt = Date.now();
      log.info("✅ Pulse Bot connected to WhatsApp");
      startWatchdog(sock);
    }

    if (connection === "close") {
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
      botConnected = false;
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      log.warn({ statusCode }, "Connection closed");

      if (statusCode === DisconnectReason.loggedOut) {
        log.error("Logged out — re-scan QR at /qr");
        reconnectAttempts = 0;
        scheduleReconnect(3);

      } else if (statusCode === DisconnectReason.connectionReplaced) {
        // 440: Railway rolling deploy — old+new container both connected.
        // Wait 60s so the competing container gets killed first.
        log.warn("Connection replaced — waiting 60s for old container to die");
        reconnectAttempts = 0;
        scheduleReconnect(60);

      } else if (statusCode === DisconnectReason.restartRequired) {
        scheduleReconnect(5);

      } else {
        const delay = Math.min(5 * Math.pow(2, reconnectAttempts), 60);
        scheduleReconnect(delay);
      }
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    lastEventAt = Date.now(); // keep watchdog fed

    // "notify" = live message; "append" = history sync
    if (type !== "notify" && type !== "append") return;

    const now = Date.now();
    const RECENT_MS = 3 * 60 * 1000;

    log.info({ type, count: messages.length }, "📩 messages.upsert fired");

    for (const msg of messages) {
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      if (type === "append") {
        const msgTs = (msg.messageTimestamp as number ?? 0) * 1000;
        if (now - msgTs > RECENT_MS) continue;
      }

      const m = msg.message;
      const text =
        m.conversation ??
        m.extendedTextMessage?.text ??
        m.imageMessage?.caption ??
        m.videoMessage?.caption ??
        m.documentMessage?.caption ??
        m.ephemeralMessage?.message?.conversation ??
        m.ephemeralMessage?.message?.extendedTextMessage?.text ??
        m.viewOnceMessage?.message?.conversation ??
        m.viewOnceMessage?.message?.extendedTextMessage?.text ??
        m.editedMessage?.message?.protocolMessage?.editedMessage?.conversation ??
        m.editedMessage?.message?.protocolMessage?.editedMessage?.extendedTextMessage?.text ??
        "";

      // Log every message — if textLen=0, also dump message keys so we can diagnose
      const msgKeys = Object.keys(m).join(",");
      log.info({ jid: jid.slice(-20), type, textLen: text.length, msgKeys, preview: text.slice(0, 80) }, "👁 message seen");

      if (!text.trim()) continue;

      try {
        if (isJidUser(jid) || isLidUser(jid)) {
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
