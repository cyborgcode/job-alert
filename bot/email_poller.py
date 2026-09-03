import asyncio
import email
import imaplib
import logging
import re
from email.header import decode_header
from email.message import Message

from telegram.ext import ContextTypes

from . import config, database, queue_manager

logger = logging.getLogger(__name__)

LINK_RE = re.compile(r"https?://\S+")


def _decode(value: str | None) -> str:
    if not value:
        return ""
    parts = decode_header(value)
    out = []
    for text, enc in parts:
        if isinstance(text, bytes):
            out.append(text.decode(enc or "utf-8", errors="replace"))
        else:
            out.append(text)
    return "".join(out)


def _extract_body(msg: Message) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain" and not part.get_filename():
                charset = part.get_content_charset() or "utf-8"
                return part.get_payload(decode=True).decode(charset, errors="replace")
        for part in msg.walk():
            if part.get_content_type() == "text/html" and not part.get_filename():
                charset = part.get_content_charset() or "utf-8"
                return part.get_payload(decode=True).decode(charset, errors="replace")
        return ""
    charset = msg.get_content_charset() or "utf-8"
    payload = msg.get_payload(decode=True)
    return payload.decode(charset, errors="replace") if payload else ""


def _fetch_new_emails() -> list[dict]:
    results: list[dict] = []
    conn = imaplib.IMAP4_SSL(config.IMAP_HOST, config.IMAP_PORT)
    try:
        conn.login(config.IMAP_USER, config.IMAP_PASSWORD)
        conn.select(config.IMAP_FOLDER)

        criteria = "(UNSEEN)"
        if config.SENDER_FILTER:
            criteria = f'(UNSEEN FROM "{config.SENDER_FILTER}")'

        status, data = conn.search(None, criteria)
        if status != "OK":
            return results

        for uid in data[0].split():
            status, msg_data = conn.fetch(uid, "(RFC822)")
            if status != "OK" or not msg_data or msg_data[0] is None:
                continue
            raw = msg_data[0][1]
            msg = email.message_from_bytes(raw)
            subject = _decode(msg.get("Subject")) or "(no subject)"
            body = _extract_body(msg).strip()
            link_match = LINK_RE.search(body)
            results.append(
                {
                    "uid": uid.decode(),
                    "subject": subject,
                    "body": body[:3500],
                    "link": link_match.group(0) if link_match else None,
                }
            )
    finally:
        try:
            conn.logout()
        except Exception:
            pass
    return results


async def poll_emails(context: ContextTypes.DEFAULT_TYPE) -> None:
    try:
        emails = await asyncio.to_thread(_fetch_new_emails)
    except Exception:
        logger.exception("Failed to poll mailbox")
        return

    for item in emails:
        if await database.job_exists(item["uid"]):
            continue
        job_id = await database.create_job(item["uid"], item["subject"], item["body"], item["link"])
        logger.info("Created job %s from email %s", job_id, item["uid"])
        await queue_manager.process_job(context, job_id)
