import logging

from telegram.ext import (
    Application,
    CallbackQueryHandler,
    CommandHandler,
    MessageHandler,
    filters,
)

from . import config, database, handlers
from .email_poller import poll_emails

logging.basicConfig(
    format="%(asctime)s %(name)s %(levelname)s %(message)s", level=logging.INFO
)
logger = logging.getLogger(__name__)


async def _post_init(application: Application) -> None:
    await database.init_db()


def build_application() -> Application:
    application = Application.builder().token(config.BOT_TOKEN).post_init(_post_init).build()

    application.add_handler(CommandHandler("start", handlers.start))
    application.add_handler(CommandHandler("queue", handlers.join_queue))
    application.add_handler(CommandHandler("leave", handlers.leave_queue))
    application.add_handler(CommandHandler("position", handlers.my_position))
    application.add_handler(CommandHandler("queuelist", handlers.list_queue))
    application.add_handler(CommandHandler("jobs", handlers.recent_jobs))
    application.add_handler(
        MessageHandler(filters.StatusUpdate.NEW_CHAT_MEMBERS, handlers.on_new_members)
    )
    application.add_handler(CallbackQueryHandler(handlers.on_callback))

    application.job_queue.run_repeating(
        poll_emails, interval=config.POLL_INTERVAL_SECONDS, first=10
    )

    return application


def main() -> None:
    application = build_application()
    application.run_polling(allowed_updates=["message", "callback_query", "chat_member"])


if __name__ == "__main__":
    main()
