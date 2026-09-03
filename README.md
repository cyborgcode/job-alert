# job-alert

Telegram bot that queues group members and assigns job alerts (received by
email from the student life department) one at a time, round-robin style.
Runs entirely on Vercel: a webhook function handles Telegram updates, and
two Vercel Cron jobs handle mailbox polling and assignment timeouts.

## Architecture

- `api/webhook.ts` — Telegram sends every update here (bot commands, button
  presses). Vercel spins this up on demand; nothing runs continuously.
- `api/cron/poll-emails.ts` — polls the IMAP mailbox for new job emails and
  hands each one to the queue.
- `api/cron/check-timeouts.ts` — finds assignments that were sent but never
  answered within `ASSIGNMENT_TIMEOUT_MINUTES`, and moves them along.
- `lib/db.ts` — Postgres (works with Neon/Vercel Postgres, Supabase, or any
  Postgres you point `DATABASE_URL` at). Serverless functions have no local
  disk to keep SQLite on, so state lives here instead.
- `lib/queueManager.ts` — assignment logic (who's next, confirm/reject,
  timeout handling).
- `lib/emailPoller.ts` — IMAP fetch + parse via `imapflow`/`mailparser`.

## How it works

- Every member DMs the bot `/start` once (required so the bot can send
  private messages), then sends `/queue` in the group to join the queue.
- The `poll-emails` cron creates a job for each new email from the
  configured sender.
- The bot DMs the job to the first person in the queue with **Confirm** /
  **Reject** buttons.
- Confirm → job is assigned, done.
- Reject, or no response within `ASSIGNMENT_TIMEOUT_MINUTES` (caught by the
  `check-timeouts` cron) → the job is offered to the next person in the
  queue, and that user is put back at the end of the queue.

## Commands

- `/start` (DM only) — register for private job alerts
- `/queue` — join the queue
- `/leave` — leave the queue
- `/position` — show your queue position
- `/queuelist` — show the current queue order
- `/jobs` — (admin only) list recent jobs and their status

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather), get the token.
2. Add the bot to the group and give it permission to read messages.
3. Provision a Postgres database (Vercel Postgres/Neon, Supabase, etc.) and
   get its connection string.
4. In the Vercel project, set these environment variables (mirrors
   `.env.example`):
   - `BOT_TOKEN`
   - `TELEGRAM_WEBHOOK_SECRET` — any random string you choose
   - `GROUP_CHAT_ID` — get it e.g. via `/start` on `@userinfobot` added to
     the group, or from the `chat` field of any update
   - `ADMIN_IDS`
   - `DATABASE_URL`
   - IMAP credentials for the mailbox that receives student life job
     alerts (for Gmail, use an App Password)
   - `SENDER_FILTER` — the student life department's sending address
   - `ASSIGNMENT_TIMEOUT_MINUTES`
   - `CRON_SECRET` — enable "Protect Cron Jobs" in the Vercel project
     settings and use the value it gives you here too
5. Deploy:

   ```
   vercel deploy --prod
   ```

6. Point Telegram at the deployed webhook:

   ```
   curl -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
     -H "Content-Type: application/json" \
     -d "{\"url\": \"https://<your-project>.vercel.app/api/webhook\", \"secret_token\": \"$TELEGRAM_WEBHOOK_SECRET\"}"
   ```

## Notes

- The bot only knows about members who have interacted with it (sent
  `/start` or `/queue`, or joined the group while the bot was present). It
  cannot enumerate a group's full member list — that's a Telegram Bot API
  limitation, not something this bot works around.
- **Cron frequency is plan-gated.** Vercel's Hobby plan runs cron jobs at
  most once a day; the `*/5 * * * *` schedules in `vercel.json` (mailbox
  polling and timeout checks every 5 minutes) require a Pro plan. On
  Hobby, job alerts and timeouts would only be picked up once a day.
- `imapflow` opens a fresh IMAP connection per cron invocation (no
  persistent connection between runs), which is what makes it work in a
  serverless environment.
