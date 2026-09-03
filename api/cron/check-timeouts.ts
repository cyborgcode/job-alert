import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../../lib/config";
import { ensureSchema } from "../../lib/db";
import { sweepTimeouts } from "../../lib/queueManager";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const cronSecret = config.cronSecret();
  if (cronSecret && req.headers.authorization !== `Bearer ${cronSecret}`) {
    res.status(401).end();
    return;
  }

  await ensureSchema();
  const timedOut = await sweepTimeouts();
  res.status(200).json({ ok: true, timedOut });
}
