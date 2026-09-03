import datetime
from typing import Optional

import aiosqlite

from . import config

SCHEMA = """
CREATE TABLE IF NOT EXISTS members (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    full_name TEXT,
    private_chat_id INTEGER,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS queue (
    user_id INTEGER PRIMARY KEY REFERENCES members(user_id),
    rank INTEGER NOT NULL,
    queued_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_uid TEXT UNIQUE,
    subject TEXT,
    body TEXT,
    link TEXT,
    received_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS assignments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id INTEGER NOT NULL REFERENCES jobs(id),
    user_id INTEGER NOT NULL REFERENCES members(user_id),
    status TEXT NOT NULL DEFAULT 'sent',
    sent_at TEXT NOT NULL,
    responded_at TEXT
);
"""


def _now() -> str:
    return datetime.datetime.utcnow().isoformat()


async def init_db() -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.executescript(SCHEMA)
        await db.commit()


async def upsert_member(user_id: int, username: Optional[str], full_name: str) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.execute(
            """
            INSERT INTO members (user_id, username, full_name, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(user_id) DO UPDATE SET
                username=excluded.username,
                full_name=excluded.full_name,
                updated_at=excluded.updated_at
            """,
            (user_id, username, full_name, _now()),
        )
        await db.commit()


async def set_private_chat(user_id: int, chat_id: int) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.execute(
            "UPDATE members SET private_chat_id = ?, updated_at = ? WHERE user_id = ?",
            (chat_id, _now(), user_id),
        )
        await db.commit()


async def get_member(user_id: int) -> Optional[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM members WHERE user_id = ?", (user_id,))
        return await cursor.fetchone()


async def is_in_queue(user_id: int) -> bool:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute("SELECT 1 FROM queue WHERE user_id = ?", (user_id,))
        return (await cursor.fetchone()) is not None


async def add_to_queue(user_id: int) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute("SELECT COALESCE(MAX(rank), 0) FROM queue")
        (max_rank,) = await cursor.fetchone()
        await db.execute(
            "INSERT OR IGNORE INTO queue (user_id, rank, queued_at) VALUES (?, ?, ?)",
            (user_id, max_rank + 1, _now()),
        )
        await db.commit()


async def remove_from_queue(user_id: int) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.execute("DELETE FROM queue WHERE user_id = ?", (user_id,))
        await db.commit()


async def get_queue() -> list[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT q.user_id, q.rank, m.username, m.full_name
            FROM queue q JOIN members m ON m.user_id = q.user_id
            ORDER BY q.rank ASC
            """
        )
        return await cursor.fetchall()


async def get_queue_position(user_id: int) -> Optional[int]:
    rows = await get_queue()
    for idx, row in enumerate(rows, start=1):
        if row["user_id"] == user_id:
            return idx
    return None


async def get_active_assignment_user_ids() -> set[int]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute("SELECT user_id FROM assignments WHERE status = 'sent'")
        return {row[0] for row in await cursor.fetchall()}


async def pop_next_available(exclude: set[int]) -> Optional[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            """
            SELECT q.user_id, m.private_chat_id, m.full_name, m.username
            FROM queue q JOIN members m ON m.user_id = q.user_id
            WHERE m.private_chat_id IS NOT NULL
            ORDER BY q.rank ASC
            """
        )
        rows = await cursor.fetchall()
        for row in rows:
            if row["user_id"] not in exclude:
                await db.execute("DELETE FROM queue WHERE user_id = ?", (row["user_id"],))
                await db.commit()
                return row
        return None


async def create_job(source_uid: str, subject: str, body: str, link: Optional[str]) -> int:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute(
            """
            INSERT INTO jobs (source_uid, subject, body, link, received_at, status)
            VALUES (?, ?, ?, ?, ?, 'pending')
            """,
            (source_uid, subject, body, link, _now()),
        )
        await db.commit()
        return cursor.lastrowid


async def job_exists(source_uid: str) -> bool:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute("SELECT 1 FROM jobs WHERE source_uid = ?", (source_uid,))
        return (await cursor.fetchone()) is not None


async def update_job_status(job_id: int, status: str) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.execute("UPDATE jobs SET status = ? WHERE id = ?", (status, job_id))
        await db.commit()


async def get_job(job_id: int) -> Optional[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM jobs WHERE id = ?", (job_id,))
        return await cursor.fetchone()


async def list_recent_jobs(limit: int = 10) -> list[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute(
            "SELECT * FROM jobs ORDER BY id DESC LIMIT ?", (limit,)
        )
        return await cursor.fetchall()


async def create_assignment(job_id: int, user_id: int) -> int:
    async with aiosqlite.connect(config.DB_PATH) as db:
        cursor = await db.execute(
            "INSERT INTO assignments (job_id, user_id, status, sent_at) VALUES (?, ?, 'sent', ?)",
            (job_id, user_id, _now()),
        )
        await db.commit()
        return cursor.lastrowid


async def update_assignment_status(assignment_id: int, status: str) -> None:
    async with aiosqlite.connect(config.DB_PATH) as db:
        await db.execute(
            "UPDATE assignments SET status = ?, responded_at = ? WHERE id = ?",
            (status, _now(), assignment_id),
        )
        await db.commit()


async def get_assignment(assignment_id: int) -> Optional[aiosqlite.Row]:
    async with aiosqlite.connect(config.DB_PATH) as db:
        db.row_factory = aiosqlite.Row
        cursor = await db.execute("SELECT * FROM assignments WHERE id = ?", (assignment_id,))
        return await cursor.fetchone()
