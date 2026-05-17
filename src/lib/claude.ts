import Anthropic from "@anthropic-ai/sdk";
import { log } from "./logger.js";

export type ParsedSession = {
  title: string;
  description: string;
  starts_at: string;      // ISO 8601 in IST (Asia/Kolkata)
  ends_at?: string;       // ISO 8601, optional
  venue: string;
  category: "Sports" | "Social" | "Professional" | "";
  subcategory: string;
  tags: string[];
  image_url?: string;     // populated by caller if WhatsApp image detected
};

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are an event parser for Pulse, a campus event platform for ISB Mohali MBA students.
Extract structured event details from a WhatsApp message. Today's date context: ISB Mohali, India (IST, Asia/Kolkata).

Return ONLY valid JSON with these fields:
- title: short punchy event name (max 60 chars, Luma-style — e.g. "Rooftop Football · Section G")
- description: 1-3 sentence friendly description of what's happening
- starts_at: ISO 8601 datetime string in IST timezone (e.g. "2026-05-17T18:00:00+05:30"). Infer year/date from context. If only time given, use today.
- ends_at: ISO 8601 datetime in IST if duration is mentioned, otherwise omit
- venue: exact campus location (e.g. "SV3 Football Ground", "LT4", "MPH", "Atrium", "Basketball Court")
- category: one of "Sports", "Social", or "Professional"
- subcategory: specific type — for Sports: one of (Football, Basketball, Cricket, Frisbee, Table Tennis, Pickleball, Lawn Tennis, Badminton, Squash, Foosball, Pool/Billiards); for Social: (Party, Games, Movies, Hangout); for Professional: (P2P Session, Club Session, Workshop, Talk)
- tags: array of relevant tags like section names (G/H/I/J/K/L), study groups (OGSG), "open to all", sport name

If a field cannot be determined, use empty string. Never return null for title. Always return valid JSON.`;

export async function parseSession(text: string): Promise<ParsedSession | null> {
  if (!process.env.ANTHROPIC_API_KEY) {
    log.warn("ANTHROPIC_API_KEY not set — skipping Claude parse");
    return null;
  }

  try {
    const today = new Date().toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata",
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });

    const response = await client.messages.create({
      model: "claude-haiku-4-5",
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: `Today is ${today} (IST).\n\nParse this WhatsApp message into an event:\n\n${text}`,
        },
      ],
    });

    const raw = response.content[0]?.type === "text" ? response.content[0].text : "";
    // Extract JSON even if Claude wraps it in markdown
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      log.warn({ raw }, "Claude response had no JSON");
      return null;
    }

    const parsed = JSON.parse(jsonMatch[0]) as ParsedSession;
    if (!parsed.title) return null;

    log.info({ title: parsed.title, category: parsed.category }, "Claude parsed session");
    return parsed;
  } catch (err) {
    log.error({ err }, "Claude parseSession failed");
    return null;
  }
}
