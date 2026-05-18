/**
 * Event deduplication — prevents the same announcement from creating
 * multiple events when shared across WhatsApp groups.
 *
 * Three layers:
 *   1. Text fingerprint: hash of first 200 chars → skip if seen in 6h
 *   2. Sender cooldown: same JID can't trigger parse within 5 min
 *   3. Semantic dedup: after parse, check sessions table for same date ± 2h + similar title
 */

import crypto from "crypto";
import { supabase } from "./supabase.js";
import { log } from "./logger.js";

// ── In-memory caches (reset on container restart — fine for dedup) ──────────

/** Map<textHash, timestamp> — recently seen message fingerprints */
const seenTexts = new Map<string, number>();

/** Map<senderJid, timestamp> — last time this sender triggered a parse */
const senderCooldowns = new Map<string, number>();

const TEXT_DEDUP_WINDOW_MS = 6 * 60 * 60 * 1000;   // 6 hours
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
 * date (±2 hours) and similar title already exists in the DB.
 *
 * Returns the existing session ID if a duplicate is found, null otherwise.
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

    // Fetch sessions in the time window
    const { data: candidates } = await supabase
      .from("sessions")
      .select("id, title")
      .gte("starts_at", windowStart)
      .lte("starts_at", windowEnd)
      .eq("archived", false);

    if (!candidates || candidates.length === 0) return null;

    // Also check pending confirms (events not yet published)
    const { data: pending } = await supabase
      .from("bot_pending_confirms")
      .select("parsed_payload")
      .gte("expires_at", new Date().toISOString());

    const allTitles: { id: string; title: string }[] = [
      ...candidates,
      ...(pending ?? [])
        .map((p: any) => ({
          id: "pending",
          title: p.parsed_payload?.title ?? "",
        }))
        .filter((p: { title: string }) => p.title),
    ];

    // Fuzzy title match: normalized substring containment or high overlap
    const normTitle = normalize(title);

    for (const candidate of allTitles) {
      const normCandidate = normalize(candidate.title);

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
