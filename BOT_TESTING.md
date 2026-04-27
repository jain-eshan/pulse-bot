# Pulse Bot — Local Testing Guide

This walks you through connecting your personal WhatsApp to the bot for demo/testing.

## Prerequisites

- Node 20+ installed
- A Supabase project (URL + service role key) — same one the web app uses
- An Anthropic API key (for `parse-session` inside the web app's Edge Functions)
- Your phone with WhatsApp installed

## 1. Install dependencies

```bash
cd /Users/eshan/Desktop/claude/ISB/pulse-bot
npm install
```

## 2. Configure environment

Create `.env` in the `pulse-bot/` folder:

```bash
SUPABASE_URL=https://<your-project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=<service-role-key-from-supabase-dashboard>
ANTHROPIC_API_KEY=<your-anthropic-key>
# Optional — the WhatsApp group JID the bot should listen to for session announcements
PULSE_GROUP_JID=
```

> The **service role key** (not the anon key) is required so the bot can insert/read on behalf of users. Never commit this file.

## 3. Run the bot

```bash
npm run dev
```

You'll see a QR code printed in the terminal.

## 4. Link your WhatsApp

On your phone:

1. Open WhatsApp → **Settings → Linked Devices → Link a Device**
2. Scan the QR in the terminal
3. The terminal will log `connected as <your-number>` once paired

Auth state is cached in `auth_info/` — you won't need to scan again unless you delete that folder.

## 5. Link your account to the web profile

1. Open the web app (`cd isb-explorer && npm run dev`, then `http://localhost:5173`)
2. Sign in (demo mode is fine) → finish onboarding → go to **You** tab
3. Tap **Generate link code** — you'll get a 6-digit code (e.g. `482 163`)
4. From your phone, DM **yourself** on WhatsApp (i.e. message the number now running the bot from another number — or test with a friend's number) with:

   ```
   link 482163
   ```

5. Bot replies: ✅ Linked to <your name>

> For a solo demo: use a second phone / WA Web account as the "user", and keep your primary number as the bot.

## 6. Try the DM commands

DM the bot with any of these:

| Command | What it does |
|---|---|
| `help` | Lists available commands |
| `sessions` | Shows upcoming sessions from Supabase |
| `going 2` | RSVPs you to session #2 from the list |
| `link <code>` | Links your WhatsApp to a web account |

## 7. Group announcement flow (optional)

1. Add the bot's number to a WhatsApp group
2. Copy the group JID from the terminal logs when a message arrives (`[group] <jid> ...`)
3. Put it in `.env` as `PULSE_GROUP_JID` and restart
4. Post a session announcement in the group (e.g. _"Consulting P2P tonight 9PM, LT3"_)
5. Bot DMs you a parsed preview; reply `yes` to publish it

## 8. Reminders cron

`src/cron/reminders.ts` runs every 5 minutes and DMs attendees 1 hour before a session starts. To test:

- Create a session in the web app starting ~65 minutes from now
- RSVP as "going"
- Wait — you'll get a DM reminder

## Troubleshooting

- **QR expired** — restart `npm run dev`; a fresh QR is generated
- **"No matching user" on link** — code is valid for 15 min; regenerate from the web Profile page
- **Bot stops responding after a restart** — delete `auth_info/` and rescan
- **Supabase errors** — double-check the service role key, and that the `users`, `sessions`, `rsvps`, `link_codes` tables exist

## Running tests

```bash
npm test
```

11 tests cover the parser and link-code verification.
