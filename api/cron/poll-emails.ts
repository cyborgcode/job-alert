import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../../lib/config";
import { ensureSchema } from "../../lib/db";
import { pollEmails } from "../../lib/emailPoller";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = config.cronSecret();
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).end();
    return;
  }

  await ensureSchema();
  const created = await pollEmails();
  res.status(200).json({ ok: true, jobsCreated: created });
}
