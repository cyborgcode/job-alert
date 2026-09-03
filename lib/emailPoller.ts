import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { config } from "./config";
import { db } from "./db";
import { processJob } from "./queueManager";

const LINK_RE = /https?:\/\/\S+/;

export async function pollEmails(): Promise<number> {
  const client = new ImapFlow({
    host: config.imapHost(),
    port: config.imapPort(),
    secure: true,
    auth: { user: config.imapUser(), pass: config.imapPassword() },
    logger: false,
  });

  let created = 0;

  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.imapFolder());
    try {
      const searchCriteria: Record<string, unknown> = { seen: false };
      const sender = config.senderFilter();
      if (sender) searchCriteria.from = sender;

      const uids = await client.search(searchCriteria, { uid: true });
      if (!uids || uids.length === 0) return 0;

      for (const uid of uids) {
        const sourceUid = String(uid);
        if (await db.jobExists(sourceUid)) continue;

        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) continue;

        const parsed = await simpleParser(message.source);
        const subject = parsed.subject || "(no subject)";
        const bodyFull = (parsed.text || parsed.html || "").toString().trim();
        const body = bodyFull.slice(0, 3500);
        const linkMatch = body.match(LINK_RE);

        const jobId = await db.createJob(sourceUid, subject, body, linkMatch ? linkMatch[0] : null);
        created += 1;
        await processJob(jobId);
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }

  return created;
}
