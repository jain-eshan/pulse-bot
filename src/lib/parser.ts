// Pulse bot — heuristic to detect event announcements in WhatsApp groups.
// Returns true when the message has 2+ of: time / venue / action signals.

// Matches times and date references
const TIME_RE = /\b(\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}(?:th|st|nd|rd)|tonight|tomorrow|today|morning|evening|noon|midnight|this\s+week|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// ISB campus spots + common nearby venues
const VENUE_RE = /\b(LT\s*\d?|lecture\s*theatre|atrium|room\s*\d+|hall|zoom|teams|online|library|cafe|canteen|mess|sports\s*complex|auditorium|SV\s*\d|student\s*village|MPH|multi.?purpose\s*hall|lab|football\s*(ground|field)?|basketball\s*(court)?|cricket\s*(ground|pitch)?|badminton\s*(court)?|tennis\s*(court)?|squash\s*(court)?|swimming\s*pool|gym|gymnasium|foosball|pool\s*table|billiards|amphitheater|ampi|lawns?|SAC|study\s*room|rooftop|terrace|gazebo|courtyard|lounge|dining|seminar\s*room|conference\s*room|cafeteria|clubhouse|poolside)\b/i;

// Broad action signals — hosting, inviting, calling people together
const ACTION_RE = /\b(join|come|RSVP|all\s+welcome|happening|hosting?|invit(e|ing)|bring|interested|sign\s*up|signup|free\s+for\s+all|register|drop\s+by|welcome|open\s+to\s+all|planning\s+to|organiz(e|ing)|putting\s+together|calling\s+all|mixer|catch.?up|hangout?|gather(ing)?|get.?together|meetup|meet\s+up)\b/i;

export function looksLikeSessionAnnouncement(text: string): boolean {
  if (!text) return false;
  if (text.length < 60 || text.length > 3000) return false;
  let signals = 0;
  if (TIME_RE.test(text)) signals++;
  if (VENUE_RE.test(text)) signals++;
  if (ACTION_RE.test(text)) signals++;
  return signals >= 2;
}
