from telegram import Update
from telegram.ext import ContextTypes

from . import config, database, queue_manager


def is_admin(user_id: int) -> bool:
    return user_id in config.ADMIN_IDS


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if update.effective_chat.type != "private":
        await update.message.reply_text(
            "Please message me privately with /start first so I can DM you job alerts."
        )
        return

    user = update.effective_user
    await database.upsert_member(user.id, user.username, user.full_name)
    await database.set_private_chat(user.id, update.effective_chat.id)
    await update.message.reply_text(
        "You're registered. Go to the group and send /queue to join the job queue."
    )


async def on_new_members(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    for member in update.message.new_chat_members:
        if member.is_bot:
            continue
        await database.upsert_member(member.id, member.username, member.full_name)
    names = ", ".join(m.full_name for m in update.message.new_chat_members if not m.is_bot)
    if names:
        await update.message.reply_text(
            f"Welcome {names}! DM me /start, then send /queue here to join the job queue."
        )


async def join_queue(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    await database.upsert_member(user.id, user.username, user.full_name)

    member = await database.get_member(user.id)
    if member is None or member["private_chat_id"] is None:
        await update.message.reply_text(
            "Please DM me /start first so I'm able to send you job alerts privately."
        )
        return

    if await database.is_in_queue(user.id):
        position = await database.get_queue_position(user.id)
        await update.message.reply_text(f"You're already in the queue at position {position}.")
        return

    await database.add_to_queue(user.id)
    position = await database.get_queue_position(user.id)
    await update.message.reply_text(f"You've joined the queue at position {position}.")


async def leave_queue(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    if not await database.is_in_queue(user.id):
        await update.message.reply_text("You're not in the queue.")
        return
    await database.remove_from_queue(user.id)
    await update.message.reply_text("You've left the queue.")


async def my_position(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    user = update.effective_user
    position = await database.get_queue_position(user.id)
    if position is None:
        await update.message.reply_text("You're not in the queue. Send /queue to join.")
        return
    await update.message.reply_text(f"You're at position {position} in the queue.")


async def list_queue(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    rows = await database.get_queue()
    if not rows:
        await update.message.reply_text("The queue is empty.")
        return
    lines = [
        f"{i}. {row['username'] or row['full_name']}" for i, row in enumerate(rows, start=1)
    ]
    await update.message.reply_text("Current queue:\n" + "\n".join(lines))


async def recent_jobs(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not is_admin(update.effective_user.id):
        await update.message.reply_text("Admins only.")
        return
    rows = await database.list_recent_jobs()
    if not rows:
        await update.message.reply_text("No jobs recorded yet.")
        return
    lines = [f"#{row['id']} [{row['status']}] {row['subject']}" for row in rows]
    await update.message.reply_text("Recent jobs:\n" + "\n".join(lines))


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    data = query.data or ""

    if data.startswith(queue_manager.CONFIRM_PREFIX):
        assignment_id = int(data[len(queue_manager.CONFIRM_PREFIX):])
        confirmed = True
    elif data.startswith(queue_manager.REJECT_PREFIX):
        assignment_id = int(data[len(queue_manager.REJECT_PREFIX):])
        confirmed = False
    else:
        await query.answer()
        return

    reply = await queue_manager.handle_response(context, assignment_id, confirmed)
    await query.answer()
    await query.edit_message_reply_markup(reply_markup=None)
    await query.message.reply_text(reply)
