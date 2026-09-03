import { config } from "./config";

function apiUrl(method: string): string {
  return `https://api.telegram.org/bot${config.botToken()}/${method}`;
}

async function call<T = unknown>(method: string, payload: Record<string, unknown>): Promise<T> {
  const res = await fetch(apiUrl(method), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as { ok: boolean; result?: T };
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
  }
  return data.result as T;
}

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export const telegram = {
  sendMessage(
    chatId: number | string,
    text: string,
    opts: { html?: boolean; keyboard?: InlineKeyboardButton[][] } = {}
  ) {
    return call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: opts.html ? "HTML" : undefined,
      reply_markup: opts.keyboard ? { inline_keyboard: opts.keyboard } : undefined,
    });
  },

  answerCallbackQuery(callbackQueryId: string, text?: string) {
    return call("answerCallbackQuery", { callback_query_id: callbackQueryId, text });
  },

  editMessageReplyMarkup(chatId: number | string, messageId: number) {
    return call("editMessageReplyMarkup", {
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  },

  setWebhook(url: string) {
    return call("setWebhook", { url, secret_token: config.webhookSecret() });
  },
};
