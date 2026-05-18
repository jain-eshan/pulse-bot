import { log } from "./logger.js";

export interface MediaAttachment {
  url: string;
  type: "image" | "video" | "document";
  mimetype?: string;
  filename?: string;
}

export type ParsedSession = {
  title: string;
  description: string;
  starts_at: string;      // ISO 8601 in IST (Asia/Kolkata)
  ends_at?: string;
  venue: string;
  category: "Sports" | "Social" | "Professional" | "";
  subcategory: string;
  tags: string[];
  image_url?: string;           // cover image (first image attachment)
  attachments?: MediaAttachment[]; // all media: images, videos, PDFs
};

/**
 * Calls the Supabase Edge Function `parse-session` which uses OpenRouter
 * (free model: openai/gpt-oss-20b:free) — no Anthropic API key needed.
 *
 * Required env vars:
 *   ANTHROPIC_PARSE_URL  = https://<project>.supabase.co/functions/v1/parse-session
 *   ANTHROPIC_PARSE_KEY  = eyJ...   (Supabase JWT anon key — NOT sb_publishable_)
 */
export async function parseSession(text: string): Promise<ParsedSession | null> {
  const url = process.env.ANTHROPIC_PARSE_URL;
  const key = process.env.ANTHROPIC_PARSE_KEY;

  if (!url || !key) {
    log.warn("ANTHROPIC_PARSE_URL / ANTHROPIC_PARSE_KEY not set — skipping parse");
    return null;
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${key}`,
      },
      body: JSON.stringify({ text }),
    });

    if (!r.ok) {
      const errBody = await r.text().catch(() => "(unreadable)");
      log.warn({ status: r.status, errBody: errBody.slice(0, 300) }, "parse-session edge function returned non-200");
      return null;
    }

    const j = await r.json().catch(() => null);
    if (!j?.title || !j?.starts_at) {
      log.warn({ j }, "parse-session response missing title or starts_at");
      return null;
    }

    log.info({ title: j.title, venue: j.venue }, "parse-session succeeded");
    return j as ParsedSession;
  } catch (err) {
    log.error({ err }, "parse-session fetch failed");
    return null;
  }
}
