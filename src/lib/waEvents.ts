import type { WASocket } from "@whiskeysockets/baileys";
import { log } from "./logger.js";

export interface EventPayload {
  title: string;
  description?: string;
  starts_at: string; // ISO
  venue?: string;
}

/**
 * Send a WhatsApp native calendar event to a group JID.
 * Falls back to a formatted text message if the Baileys version
 * doesn't support the event message type yet.
 */
export async function sendWaEvent(
  sock: WASocket,
  jid: string,
  payload: EventPayload
): Promise<string | null> {
  const startMs = new Date(payload.starts_at).getTime();

  try {
    const sent = await (sock as any).sendMessage(jid, {
      eventMessage: {
        name: payload.title,
        description: payload.description ?? "",
        location: { degreesLatitude: 0, degreesLongitude: 0, name: payload.venue ?? "" },
        startTime: { seconds: Math.floor(startMs / 1000) },
        endTime: { seconds: Math.floor(startMs / 1000) + 3600 },
        isCanceled: false,
      },
    });

    const msgId: string | undefined = sent?.key?.id;
    log.info({ jid, msgId }, "WA native event sent");
    return msgId ?? null;
  } catch (err) {
    log.warn({ err }, "Native event failed — falling back to text");

    const date = new Date(payload.starts_at);
    const label = date.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });

    const text = [
      `📅 *${payload.title}*`,
      `🕘 ${label} IST`,
      payload.venue ? `📍 ${payload.venue}` : null,
      payload.description ? `\n${payload.description}` : null,
      "\nRSVP: pulse.eshanjain.in",
    ]
      .filter(Boolean)
      .join("\n");

    const sent = await sock.sendMessage(jid, { text });
    return sent?.key?.id ?? null;
  }
}
