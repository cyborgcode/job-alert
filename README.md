# job-alert

Telegram bot that queues group members and assigns job alerts (received by
email from the student life department) one at a time, round-robin style.

## How it works

- Every member DMs the bot `/start` once (required so the bot can send
  private messages), then sends `/queue` in the group to join the queue.
- The bot polls an IMAP mailbox for new emails from the configured sender.
- Each new email becomes a job. The bot DMs the job to the first person in
  the queue with **Confirm** / **Reject** buttons.
- Confirm → job is assigned, done.
- Reject, or no response within `ASSIGNMENT_TIMEOUT_MINUTES` → the job is
  offered to the next person in the queue, and that user is put back at the
  end of the queue.

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
3. Copy `.env.example` to `.env` and fill in:
   - `BOT_TOKEN`
   - `GROUP_CHAT_ID` (get it e.g. via `/start` on `@userinfobot` added to
     the group, or from the `chat` field of any update)
   - `ADMIN_IDS`
   - IMAP credentials for the mailbox that receives student life job alerts
     (for Gmail, use an App Password)
   - `SENDER_FILTER` — the student life department's sending address
4. Install dependencies:

   ```
   pip install -r requirements.txt
   ```

5. Run:

   ```
   python -m bot.main
   ```

## Notes

- The bot only knows about members who have interacted with it (sent
  `/start` or `/queue`, or joined the group while the bot was present). It
  cannot enumerate a group's full member list — that's a Telegram
  Bot API limitation, not something this bot works around.
- Data is stored in a local SQLite file (`DB_PATH`, default
  `data/job_alert.db`).
