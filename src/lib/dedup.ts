/**
 * Event deduplication — prevents the same announcement from creating
 * multiple events when shared across WhatsApp groups.
 *
 * Three layers:
 *   1. Text fingerprint: hash of first 200 chars → skip if seen in 48h
 *   2. Sender cooldown: same JID can't trigger parse within 5 min
 *   3. Semantic dedup: after parse, check sessions + bot_dedup_log for
 *      same date ± 2h + similar title. Covers multi-day reminders because
 *      the dedup log persists 7 days in Supabase.
 *
 * After a successful parse, call `recordProcessedEvent()` to write to
 * the persistent dedup log so reminders days later are still caught.
 */

import crypto from "crypto";
import { supabase } from "./supabase.js";
import { log } from "./logger.js";

// ── In-memory caches (fast path — reset on container restart) ───────────────

/** Map<textHash, timestamp> — recently seen message fingerprints */
const seenTexts = new Map<string, number>();

/** Map<senderJid, timestamp> — last time this sender triggered a parse */
const senderCooldowns = new Map<string, number>();

const TEXT_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;  // 48 hours (covers day-before reminders)
const SENDER_COOLDOWN_MS  = 5 * 60 * 1000;          // 5 minutes
const SEMANTIC_WINDOW_HOURS = 2;                     // ±2h for date match

// Cleanup stale entries every 30 min to avoid unbounded growth
setInterval(() => {
  const now = Date.now();
  for (const [k, ts] of seenTexts) {
    if (now - ts > TEXT_DEDUP_WINDOW_MS) seenTexts.delete(k);
  }
  for (const [k, ts] of senderCooldowns) {
    if (now - ts > SENDER_COOLDOWN_MS) senderCooldowns.delete(k);
  }
}, 30 * 60 * 1000);

// ── Layer 1: Text fingerprint ───────────────────────────────────────────────

function textFingerprint(text: string): string {
  // Normalize: lowercase, collapse whitespace, take first 200 chars
  const normalized = text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 200);
  return crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/**
 * Returns true if this exact text (or near-identical) was already
 * seen within the dedup window. Marks it as seen if new.
 */
export function isTextDuplicate(text: string): boolean {
  const fp = textFingerprint(text);
  const lastSeen = seenTexts.get(fp);

  if (lastSeen && Date.now() - lastSeen < TEXT_DEDUP_WINDOW_MS) {
    log.info({ fp }, "🔄 dedup: text fingerprint already seen — skipping");
    return true;
  }

  seenTexts.set(fp, Date.now());
  return false;
}

// ── Layer 2: Sender cooldown ────────────────────────────────────────────────

/**
 * Returns true if this sender has triggered a parse too recently.
 * Marks them as active if not on cooldown.
 */
export function isSenderOnCooldown(senderJid: string): boolean {
  const lastTrigger = senderCooldowns.get(senderJid);

  if (lastTrigger && Date.now() - lastTrigger < SENDER_COOLDOWN_MS) {
    log.info({ senderJid: senderJid.slice(-15) }, "🔄 dedup: sender on cooldown — skipping");
    return true;
  }

  senderCooldowns.set(senderJid, Date.now());
  return false;
}

// ── Layer 3: Semantic dedup (post-parse) ────────────────────────────────────

/**
 * After the LLM has parsed an event, check if a session with the same
 * date (±2 hours) and similar title already exists.
 *
 * Checks three sources:
 *   - Published sessions (sessions table)
 *   - Pending bot confirms (bot_pending_confirms — 15 min TTL)
 *   - Persistent dedup log (bot_dedup_log — 7 day TTL, survives restarts)
 *
 * Returns the existing session/log ID if a duplicate is found, null otherwise.
 */
export async function findSemanticDuplicate(
  title: string,
  startsAt: string
): Promise<string | null> {
  if (!title || !startsAt) return null;

  try {
    const eventTime = new Date(startsAt);
    if (isNaN(eventTime.getTime())) return null;

    const windowStart = new Date(eventTime.getTime() - SEMANTIC_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
    const windowEnd = new Date(eventTime.getTime() + SEMANTIC_WINDOW_HOURS * 60 * 60 * 1000).toISOString();

    // Fetch from all three sources in parallel
    const [sessionsRes, pendingRes, dedupLogRes] = await Promise.all([
      supabase
        .from("sessions")
        .select("id, title")
        .gte("starts_at", windowStart)
        .lte("starts_at", windowEnd)
        .eq("archived", false),
      supabase
        .from("bot_pending_confirms")
        .select("parsed_payload")
        .gte("expires_at", new Date().toISOString()),
      supabase
        .from("bot_dedup_log")
        .select("id, title")
        .gte("starts_at", windowStart)
        .lte("starts_at", windowEnd)
        .gte("expires_at", new Date().toISOString()),
    ]);

    const allTitles: { id: string; title: string }[] = [
      ...(sessionsRes.data ?? []),
      ...(pendingRes.data ?? [])
        .map((p: any) => ({
          id: "pending",
          title: p.parsed_payload?.title ?? "",
        }))
        .filter((p: { title: string }) => p.title),
      ...(dedupLogRes.data ?? []).map((d: any) => ({
        id: `dedup-${d.id}`,
        title: d.title,
      })),
    ];

    if (allTitles.length === 0) return null;

    // Fuzzy title match: normalized substring containment or high overlap
    const normTitle = normalize(title);

    for (const candidate of allTitles) {
      const normCandidate = normalize(candidate.title);
      if (!normCandidate) continue;

      // Exact match after normalization
      if (normTitle === normCandidate) {
        log.info({ existingId: candidate.id, title: candidate.title }, "🔄 dedup: exact title match found");
        return candidate.id;
      }

      // One title contains the other (handles truncated titles)
      if (normTitle.includes(normCandidate) || normCandidate.includes(normTitle)) {
        log.info({ existingId: candidate.id, title: candidate.title }, "🔄 dedup: substring title match found");
        return candidate.id;
      }

      // Word overlap ≥ 70%
      if (wordOverlap(normTitle, normCandidate) >= 0.7) {
        log.info({ existingId: candidate.id, title: candidate.title }, "🔄 dedup: word overlap match found");
        return candidate.id;
      }
    }

    return null;
  } catch (err) {
    log.warn({ err }, "dedup: semantic check failed — allowing event");
    return null;
  }
}

// ── Persistent dedup log ────────────────────────────────────────────────────

/**
 * Record that the bot has processed an event. Called after successful parse,
 * regardless of whether the sender confirms it. This ensures reminders
 * sent days later are caught by Layer 3.
 */
export async function recordProcessedEvent(title: string, startsAt: string): Promise<void> {
  try {
    const eventHash = crypto
      .createHash("sha256")
      .update(normalize(title) + "|" + startsAt)
      .digest("hex")
      .slice(0, 24);

    // Check if already recorded (avoid duplicating the log entry itself)
    const { data: existing } = await supabase
      .from("bot_dedup_log")
      .select("id")
      .eq("event_hash", eventHash)
      .maybeSingle();

    if (existing) return;

    await supabase.from("bot_dedup_log").insert({
      event_hash: eventHash,
      title,
      starts_at: startsAt,
    });

    log.info({ eventHash, title }, "📝 dedup: recorded event in persistent log");
  } catch (err) {
    log.warn({ err }, "dedup: failed to write dedup log — non-fatal");
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, "")  // strip punctuation/emoji
    .replace(/\s+/g, " ")
    .trim();
}

function wordOverlap(a: string, b: string): number {
  const wordsA = new Set(a.split(" ").filter(Boolean));
  const wordsB = new Set(b.split(" ").filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;

  let matches = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) matches++;
  }

  // Overlap relative to the smaller set
  return matches / Math.min(wordsA.size, wordsB.size);
}
