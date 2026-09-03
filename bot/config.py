import os
from dotenv import load_dotenv

load_dotenv()


def _split_ids(raw: str) -> set[int]:
    return {int(x) for x in raw.split(",") if x.strip()}


BOT_TOKEN = os.environ["BOT_TOKEN"]

GROUP_CHAT_ID = int(os.environ["GROUP_CHAT_ID"]) if os.environ.get("GROUP_CHAT_ID") else None
ADMIN_IDS = _split_ids(os.environ.get("ADMIN_IDS", ""))

IMAP_HOST = os.environ["IMAP_HOST"]
IMAP_PORT = int(os.environ.get("IMAP_PORT", "993"))
IMAP_USER = os.environ["IMAP_USER"]
IMAP_PASSWORD = os.environ["IMAP_PASSWORD"]
IMAP_FOLDER = os.environ.get("IMAP_FOLDER", "INBOX")
SENDER_FILTER = os.environ.get("SENDER_FILTER", "")

POLL_INTERVAL_SECONDS = int(os.environ.get("POLL_INTERVAL_SECONDS", "60"))
ASSIGNMENT_TIMEOUT_MINUTES = int(os.environ.get("ASSIGNMENT_TIMEOUT_MINUTES", "15"))

DB_PATH = os.environ.get("DB_PATH", "data/job_alert.db")
