import { config } from "./config";
import { db } from "./db";
import { telegram } from "./telegram";
import { CONFIRM_PREFIX, REJECT_PREFIX, handleResponse } from "./queueManager";

interface TgUser {
  id: number;
  username?: string;
  first_name?: string;
  last_name?: string;
  is_bot?: boolean;
}

interface TgChat {
  id: number;
  type: string;
}

interface TgMessage {
  message_id: number;
  chat: TgChat;
  from?: TgUser;
  text?: string;
  new_chat_members?: TgUser[];
}

interface TgCallbackQuery {
  id: string;
  data?: string;
  from: TgUser;
  message?: TgMessage;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

function fullName(user: TgUser): string {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || user.username || String(user.id);
}

function isAdmin(userId: number): boolean {
  return config.adminIds().has(String(userId));
}

function command(text: string | undefined): string | undefined {
  if (!text || !text.startsWith("/")) return undefined;
  return text.split(/[\s@]/)[0].slice(1).toLowerCase();
}

async function handleStart(message: TgMessage) {
  if (message.chat.type !== "private" || !message.from) {
    await telegram.sendMessage(
      message.chat.id,
      "Please message me privately with /start first so I can DM you job alerts."
    );
    return;
  }
  const user = message.from;
  await db.upsertMember(user.id, user.username ?? null, fullName(user));
  await db.setPrivateChat(user.id, message.chat.id);
  await telegram.sendMessage(
    message.chat.id,
    "You're registered. Go to the group and send /queue to join the job queue."
  );
}

async function handleNewMembers(message: TgMessage) {
  const members = (message.new_chat_members ?? []).filter((m) => !m.is_bot);
  for (const member of members) {
    await db.upsertMember(member.id, member.username ?? null, fullName(member));
  }
  if (members.length) {
    const names = members.map(fullName).join(", ");
    await telegram.sendMessage(
      message.chat.id,
      `Welcome ${names}! DM me /start, then send /queue here to join the job queue.`
    );
  }
}

async function handleJoinQueue(message: TgMessage) {
  if (!message.from) return;
  const user = message.from;
  await db.upsertMember(user.id, user.username ?? null, fullName(user));

  const member = await db.getMember(user.id);
  if (!member || !member.private_chat_id) {
    await telegram.sendMessage(
      message.chat.id,
      "Please DM me /start first so I'm able to send you job alerts privately."
    );
    return;
  }

  if (await db.isInQueue(user.id)) {
    const position = await db.getQueuePosition(user.id);
    await telegram.sendMessage(message.chat.id, `You're already in the queue at position ${position}.`);
    return;
  }

  await db.addToQueue(user.id);
  const position = await db.getQueuePosition(user.id);
  await telegram.sendMessage(message.chat.id, `You've joined the queue at position ${position}.`);
}

async function handleLeaveQueue(message: TgMessage) {
  if (!message.from) return;
  const user = message.from;
  if (!(await db.isInQueue(user.id))) {
    await telegram.sendMessage(message.chat.id, "You're not in the queue.");
    return;
  }
  await db.removeFromQueue(user.id);
  await telegram.sendMessage(message.chat.id, "You've left the queue.");
}

async function handlePosition(message: TgMessage) {
  if (!message.from) return;
  const position = await db.getQueuePosition(message.from.id);
  if (position === undefined) {
    await telegram.sendMessage(message.chat.id, "You're not in the queue. Send /queue to join.");
    return;
  }
  await telegram.sendMessage(message.chat.id, `You're at position ${position} in the queue.`);
}

async function handleQueueList(message: TgMessage) {
  const rows = await db.getQueue();
  if (!rows.length) {
    await telegram.sendMessage(message.chat.id, "The queue is empty.");
    return;
  }
  const lines = rows.map((row, i) => `${i + 1}. ${row.username ?? row.full_name}`);
  await telegram.sendMessage(message.chat.id, "Current queue:\n" + lines.join("\n"));
}

async function handleRecentJobs(message: TgMessage) {
  if (!message.from || !isAdmin(message.from.id)) {
    await telegram.sendMessage(message.chat.id, "Admins only.");
    return;
  }
  const rows = await db.listRecentJobs();
  if (!rows.length) {
    await telegram.sendMessage(message.chat.id, "No jobs recorded yet.");
    return;
  }
  const lines = rows.map((row) => `#${row.id} [${row.status}] ${row.subject}`);
  await telegram.sendMessage(message.chat.id, "Recent jobs:\n" + lines.join("\n"));
}

export async function handleUpdate(update: TgUpdate): Promise<void> {
  if (update.message) {
    const message = update.message;
    if (message.new_chat_members?.length) {
      await handleNewMembers(message);
      return;
    }
    switch (command(message.text)) {
      case "start":
        return handleStart(message);
      case "queue":
        return handleJoinQueue(message);
      case "leave":
        return handleLeaveQueue(message);
      case "position":
        return handlePosition(message);
      case "queuelist":
        return handleQueueList(message);
      case "jobs":
        return handleRecentJobs(message);
      default:
        return;
    }
  }

  if (update.callback_query) {
    const query = update.callback_query;
    const data = query.data ?? "";
    let assignmentId: number | undefined;
    let confirmed = false;

    if (data.startsWith(CONFIRM_PREFIX)) {
      assignmentId = Number(data.slice(CONFIRM_PREFIX.length));
      confirmed = true;
    } else if (data.startsWith(REJECT_PREFIX)) {
      assignmentId = Number(data.slice(REJECT_PREFIX.length));
      confirmed = false;
    } else {
      await telegram.answerCallbackQuery(query.id);
      return;
    }

    const reply = await handleResponse(assignmentId, confirmed);
    await telegram.answerCallbackQuery(query.id);
    if (query.message) {
      await telegram.editMessageReplyMarkup(query.message.chat.id, query.message.message_id);
      await telegram.sendMessage(query.message.chat.id, reply);
    }
  }
}
