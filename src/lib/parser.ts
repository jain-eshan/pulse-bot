// Pulse bot — heuristic to detect event announcements in WhatsApp groups.
// Returns true when the message has 2+ of: time / venue / action signals.

const TIME_RE   = /\b(\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|tonight|tomorrow|today|morning|evening|noon|midnight)\b/i;
const VENUE_RE  = /\b(LT\s*\d|atrium|room\s*\d+|hall|zoom|teams|online|library|cafe|canteen|mess|sports\s*complex|auditorium|sv\s*\d|mph|lab|meet)\b/i;
const ACTION_RE = /\b(join|come|RSVP|all\s+welcome|happening|hosting|invite|bring|interested|sign\s*up|signup|free\s+for\s+all)\b/i;

export function looksLikeSessionAnnouncement(text: string): boolean {
  if (!text) return false;
  if (text.length < 60 || text.length > 2000) return false;
  let signals = 0;
  if (TIME_RE.test(text)) signals++;
  if (VENUE_RE.test(text)) signals++;
  if (ACTION_RE.test(text)) signals++;
  return signals >= 2;
}
