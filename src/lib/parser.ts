// Pulse bot — heuristic to detect event announcements in WhatsApp groups.
// Returns true when the message has 2+ of: time / venue / action signals.

const TIME_RE = /\b(\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|tonight|tomorrow|today|morning|evening|noon|midnight)\b/i;

// ISB Mohali campus locations + common meeting spots
const VENUE_RE = /\b(LT\s*\d?|lecture\s*theatre|atrium|room\s*\d+|hall|zoom|teams|online|library|cafe|canteen|mess|sports\s*complex|auditorium|SV\s*\d|student\s*village|MPH|multi.?purpose\s*hall|lab|meet|football\s*(ground|field)?|basketball\s*(court)?|cricket\s*(ground|pitch)?|badminton\s*(court)?|tennis\s*(court)?|squash\s*(court)?|swimming\s*pool|gym|gymnasium|foosball|pool\s*table|billiards|amphitheater|ampi|lawns?|SAC|study\s*room|rooftop|terrace)\b/i;

const ACTION_RE = /\b(join|come|RSVP|all\s+welcome|happening|hosting|invite|bring|interested|sign\s*up|signup|free\s+for\s+all|register|drop\s+by|welcome|open\s+to\s+all)\b/i;

export function looksLikeSessionAnnouncement(text: string): boolean {
  if (!text) return false;
  if (text.length < 60 || text.length > 3000) return false;
  let signals = 0;
  if (TIME_RE.test(text)) signals++;
  if (VENUE_RE.test(text)) signals++;
  if (ACTION_RE.test(text)) signals++;
  return signals >= 2;
}
