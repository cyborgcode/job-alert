import logging

from telegram import InlineKeyboardButton, InlineKeyboardMarkup
from telegram.ext import ContextTypes

from . import config, database

logger = logging.getLogger(__name__)

CONFIRM_PREFIX = "job_confirm:"
REJECT_PREFIX = "job_reject:"


def _job_message(subject: str, body: str, link: str | None) -> str:
    text = f"📢 New job alert\n\n<b>{subject}</b>\n\n{body}"
    if link:
        text += f"\n\n{link}"
    text += "\n\nYou're up in the queue. Confirm or reject within " \
        f"{config.ASSIGNMENT_TIMEOUT_MINUTES} minutes."
    return text


async def process_job(context: ContextTypes.DEFAULT_TYPE, job_id: int) -> None:
    job = await database.get_job(job_id)
    if job is None or job["status"] not in ("pending", "reassigning"):
        return

    active = await database.get_active_assignment_user_ids()
    candidate = await database.pop_next_available(exclude=active)

    if candidate is None:
        await database.update_job_status(job_id, "pending")
        if config.GROUP_CHAT_ID:
            await context.bot.send_message(
                config.GROUP_CHAT_ID,
                f"⚠️ No one available in the queue right now for job:\n<b>{job['subject']}</b>\n"
                "Use /queue to join and get considered for new jobs.",
                parse_mode="HTML",
            )
        return

    assignment_id = await database.create_assignment(job_id, candidate["user_id"])
    await database.update_job_status(job_id, "assigning")

    keyboard = InlineKeyboardMarkup(
        [
            [
                InlineKeyboardButton("✅ Confirm", callback_data=f"{CONFIRM_PREFIX}{assignment_id}"),
                InlineKeyboardButton("❌ Reject", callback_data=f"{REJECT_PREFIX}{assignment_id}"),
            ]
        ]
    )

    try:
        await context.bot.send_message(
            candidate["private_chat_id"],
            _job_message(job["subject"], job["body"], job["link"]),
            parse_mode="HTML",
            reply_markup=keyboard,
        )
    except Exception:
        logger.exception("Failed to DM candidate %s, skipping", candidate["user_id"])
        await database.update_assignment_status(assignment_id, "undeliverable")
        await process_job(context, job_id)
        return

    if config.GROUP_CHAT_ID:
        name = candidate["username"] or candidate["full_name"]
        await context.bot.send_message(
            config.GROUP_CHAT_ID,
            f"📨 Job \"{job['subject']}\" was sent to {name}. Waiting for confirmation…",
        )

    context.job_queue.run_once(
        _handle_timeout,
        when=config.ASSIGNMENT_TIMEOUT_MINUTES * 60,
        data={"assignment_id": assignment_id, "job_id": job_id},
        name=f"timeout:{assignment_id}",
    )


async def _handle_timeout(context: ContextTypes.DEFAULT_TYPE) -> None:
    data = context.job.data
    assignment_id = data["assignment_id"]
    job_id = data["job_id"]

    assignment = await database.get_assignment(assignment_id)
    if assignment is None or assignment["status"] != "sent":
        return

    await database.update_assignment_status(assignment_id, "timeout")
    await database.add_to_queue(assignment["user_id"])

    try:
        await context.bot.send_message(
            (await database.get_member(assignment["user_id"]))["private_chat_id"],
            "⌛ You didn't respond in time, so this job went to the next person in "
            "the queue. You've been moved to the end of the queue.",
        )
    except Exception:
        logger.exception("Failed to notify user %s of timeout", assignment["user_id"])

    await process_job(context, job_id)


async def handle_response(context: ContextTypes.DEFAULT_TYPE, assignment_id: int, confirmed: bool) -> str:
    assignment = await database.get_assignment(assignment_id)
    if assignment is None:
        return "This assignment no longer exists."
    if assignment["status"] != "sent":
        return "This job has already been resolved."

    for j in context.job_queue.get_jobs_by_name(f"timeout:{assignment_id}"):
        j.schedule_removal()

    job = await database.get_job(assignment["job_id"])

    if confirmed:
        await database.update_assignment_status(assignment_id, "confirmed")
        await database.update_job_status(assignment["job_id"], "completed")
        if config.GROUP_CHAT_ID:
            member = await database.get_member(assignment["user_id"])
            name = member["username"] or member["full_name"]
            await context.bot.send_message(
                config.GROUP_CHAT_ID,
                f"✅ {name} confirmed and was assigned: <b>{job['subject']}</b>",
                parse_mode="HTML",
            )
        return "You're confirmed for this job. Good luck!"

    await database.update_assignment_status(assignment_id, "rejected")
    await database.add_to_queue(assignment["user_id"])
    if config.GROUP_CHAT_ID:
        await context.bot.send_message(
            config.GROUP_CHAT_ID,
            f"❌ Job \"{job['subject']}\" was rejected, offering to the next person in the queue.",
        )
    await process_job(context, assignment["job_id"])
    return "You rejected the job. You've been moved to the end of the queue."
