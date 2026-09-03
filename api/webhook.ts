import type { VercelRequest, VercelResponse } from "@vercel/node";
import { config } from "../lib/config";
import { ensureSchema } from "../lib/db";
import { handleUpdate, type TgUpdate } from "../lib/handlers";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== "POST") {
    res.status(405).end();
    return;
  }

  const secret = req.headers["x-telegram-bot-api-secret-token"];
  if (secret !== config.webhookSecret()) {
    res.status(401).end();
    return;
  }

  await ensureSchema();

  try {
    await handleUpdate(req.body as TgUpdate);
  } catch (err) {
    console.error("webhook handler error", err);
  }

  res.status(200).json({ ok: true });
}
