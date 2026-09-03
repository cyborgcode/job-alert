import { Pool, type QueryResultRow } from "pg";
import { config } from "./config";

let pool: Pool | undefined;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: config.databaseUrl(), max: 5 });
  }
  return pool;
}

async function q<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(text, params);
  return result.rows;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS members (
  user_id BIGINT PRIMARY KEY,
  username TEXT,
  full_name TEXT,
  private_chat_id BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS queue (
  user_id BIGINT PRIMARY KEY REFERENCES members(user_id),
  queue_rank BIGINT NOT NULL,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  source_uid TEXT UNIQUE,
  subject TEXT,
  body TEXT,
  link TEXT,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL DEFAULT 'pending'
);

CREATE TABLE IF NOT EXISTS assignments (
  id SERIAL PRIMARY KEY,
  job_id INTEGER NOT NULL REFERENCES jobs(id),
  user_id BIGINT NOT NULL REFERENCES members(user_id),
  status TEXT NOT NULL DEFAULT 'sent',
  sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  responded_at TIMESTAMPTZ
);
`;

let schemaReady: Promise<void> | undefined;

export function ensureSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = getPool()
      .query(SCHEMA)
      .then(() => undefined);
  }
  return schemaReady;
}

export interface Member {
  user_id: string;
  username: string | null;
  full_name: string | null;
  private_chat_id: string | null;
  updated_at: string;
}

export interface Job {
  id: number;
  source_uid: string | null;
  subject: string;
  body: string;
  link: string | null;
  received_at: string;
  status: string;
}

export interface Assignment {
  id: number;
  job_id: number;
  user_id: string;
  status: string;
  sent_at: string;
  responded_at: string | null;
}

export interface QueueRow {
  user_id: string;
  queue_rank: string;
  username: string | null;
  full_name: string | null;
}

export const db = {
  async upsertMember(userId: number | string, username: string | null, fullName: string) {
    await q(
      `INSERT INTO members (user_id, username, full_name, updated_at)
       VALUES ($1, $2, $3, now())
       ON CONFLICT (user_id) DO UPDATE SET
         username = excluded.username,
         full_name = excluded.full_name,
         updated_at = now()`,
      [userId, username, fullName]
    );
  },

  async setPrivateChat(userId: number | string, chatId: number | string) {
    await q(`UPDATE members SET private_chat_id = $1, updated_at = now() WHERE user_id = $2`, [
      chatId,
      userId,
    ]);
  },

  async getMember(userId: number | string): Promise<Member | undefined> {
    const rows = await q<Member>(`SELECT * FROM members WHERE user_id = $1`, [userId]);
    return rows[0];
  },

  async isInQueue(userId: number | string): Promise<boolean> {
    const rows = await q(`SELECT 1 FROM queue WHERE user_id = $1`, [userId]);
    return rows.length > 0;
  },

  async addToQueue(userId: number | string) {
    const rows = await q<{ max: string | null }>(`SELECT MAX(queue_rank) AS max FROM queue`);
    const nextRank = Number(rows[0]?.max ?? 0) + 1;
    await q(
      `INSERT INTO queue (user_id, queue_rank, queued_at) VALUES ($1, $2, now())
       ON CONFLICT (user_id) DO NOTHING`,
      [userId, nextRank]
    );
  },

  async removeFromQueue(userId: number | string) {
    await q(`DELETE FROM queue WHERE user_id = $1`, [userId]);
  },

  async getQueue(): Promise<QueueRow[]> {
    return q<QueueRow>(
      `SELECT q.user_id, q.queue_rank, m.username, m.full_name
       FROM queue q JOIN members m ON m.user_id = q.user_id
       ORDER BY q.queue_rank ASC`
    );
  },

  async getQueuePosition(userId: number | string): Promise<number | undefined> {
    const rows = await db.getQueue();
    const idx = rows.findIndex((r) => String(r.user_id) === String(userId));
    return idx === -1 ? undefined : idx + 1;
  },

  async getActiveAssignmentUserIds(): Promise<Set<string>> {
    const rows = await q<{ user_id: string }>(`SELECT user_id FROM assignments WHERE status = 'sent'`);
    return new Set(rows.map((r) => String(r.user_id)));
  },

  async popNextAvailable(
    exclude: Set<string>
  ): Promise<{ user_id: string; private_chat_id: string; full_name: string | null; username: string | null } | undefined> {
    const rows = await q<{
      user_id: string;
      private_chat_id: string;
      full_name: string | null;
      username: string | null;
    }>(
      `SELECT q.user_id, m.private_chat_id, m.full_name, m.username
       FROM queue q JOIN members m ON m.user_id = q.user_id
       WHERE m.private_chat_id IS NOT NULL
       ORDER BY q.queue_rank ASC`
    );
    for (const row of rows) {
      if (!exclude.has(String(row.user_id))) {
        await q(`DELETE FROM queue WHERE user_id = $1`, [row.user_id]);
        return row;
      }
    }
    return undefined;
  },

  async createJob(sourceUid: string, subject: string, body: string, link: string | null): Promise<number> {
    const rows = await q<{ id: number }>(
      `INSERT INTO jobs (source_uid, subject, body, link, received_at, status)
       VALUES ($1, $2, $3, $4, now(), 'pending')
       RETURNING id`,
      [sourceUid, subject, body, link]
    );
    return rows[0].id;
  },

  async jobExists(sourceUid: string): Promise<boolean> {
    const rows = await q(`SELECT 1 FROM jobs WHERE source_uid = $1`, [sourceUid]);
    return rows.length > 0;
  },

  async updateJobStatus(jobId: number, status: string) {
    await q(`UPDATE jobs SET status = $1 WHERE id = $2`, [status, jobId]);
  },

  async getJob(jobId: number): Promise<Job | undefined> {
    const rows = await q<Job>(`SELECT * FROM jobs WHERE id = $1`, [jobId]);
    return rows[0];
  },

  async listRecentJobs(limit = 10): Promise<Job[]> {
    return q<Job>(`SELECT * FROM jobs ORDER BY id DESC LIMIT $1`, [limit]);
  },

  async createAssignment(jobId: number, userId: number | string): Promise<number> {
    const rows = await q<{ id: number }>(
      `INSERT INTO assignments (job_id, user_id, status, sent_at)
       VALUES ($1, $2, 'sent', now())
       RETURNING id`,
      [jobId, userId]
    );
    return rows[0].id;
  },

  async updateAssignmentStatus(assignmentId: number, status: string) {
    await q(`UPDATE assignments SET status = $1, responded_at = now() WHERE id = $2`, [
      status,
      assignmentId,
    ]);
  },

  async getAssignment(assignmentId: number): Promise<Assignment | undefined> {
    const rows = await q<Assignment>(`SELECT * FROM assignments WHERE id = $1`, [assignmentId]);
    return rows[0];
  },

  async getStaleSentAssignments(timeoutMinutes: number): Promise<Assignment[]> {
    return q<Assignment>(
      `SELECT * FROM assignments
       WHERE status = 'sent' AND sent_at < now() - ($1 || ' minutes')::interval`,
      [timeoutMinutes]
    );
  },
};
