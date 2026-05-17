// Pulse bot — heuristic to detect event announcements in WhatsApp groups.
//
// Detection logic:
//   TIME + ACTION  → always detect (venue is not required — it could be
//                    "at Nalanda", "in my quad", "at the Hub" — anywhere)
//   TIME + VENUE   → detect (known venue name gives extra confidence)
//   VENUE + ACTION → detect (even without explicit time, e.g. "LT4 session, join us")

// Matches time references and date expressions
const TIME_RE = /\b(\d{1,2}\s*(?:am|pm)|\d{1,2}:\d{2}|\d{1,2}(?:th|st|nd|rd)|tonight|tomorrow|today|morning|evening|noon|midnight|this\s+week|next\s+week|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;

// Known ISB campus spots — not exhaustive, just a confidence booster
const VENUE_RE = /\b(LT\s*\d?|lecture\s*theatre|nalanda|atrium|room\s*\d+|hall|zoom|teams|online|library|cafe|canteen|mess|sports\s*complex|auditorium|SV\s*\d|student\s*village|MPH|multi.?purpose\s*hall|lab|football\s*(ground|field)?|basketball\s*(court)?|cricket\s*(ground|pitch)?|badminton\s*(court)?|tennis\s*(court)?|squash\s*(court)?|swimming\s*pool|gym|gymnasium|foosball|pool\s*table|billiards|amphitheater|ampi|lawns?|SAC|study\s*room|rooftop|terrace|gazebo|courtyard|lounge|dining|seminar\s*room|conference\s*room|cafeteria|clubhouse|poolside|quad|the\s+hub)\b/i;

// Broad action/intent signals — someone is organizing or calling people together
const ACTION_RE = /\b(join|come|RSVP|all\s+welcome|happening|hosting?|invit(e|ed|ing)|bring|interested|sign\s*up|signup|free\s+for\s+all|register|drop\s+by|welcome|open\s+to\s+all|planning\s+to|organiz(e|ing)|putting\s+together|calling\s+all|mixer|catch.?up|hangout?|gather(ing)?|get.?together|meetup|meet\s+up|exclusive|everyone\s+(welcome|invited))\b/i;

export function looksLikeSessionAnnouncement(text: string): boolean {
  if (!text) return false;
  if (text.length < 60 || text.length > 3000) return false;

  const hasTime   = TIME_RE.test(text);
  const hasVenue  = VENUE_RE.test(text);
  const hasAction = ACTION_RE.test(text);

  // TIME + ACTION is sufficient — venue name doesn't need to be in our list
  if (hasTime && hasAction) return true;
  // Known venue + either time or action also works
  if (hasVenue && (hasTime || hasAction)) return true;

  return false;
}
