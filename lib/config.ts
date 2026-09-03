function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function ids(name: string): Set<string> {
  return new Set(
    (process.env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
}

export const config = {
  botToken: () => required("BOT_TOKEN"),
  webhookSecret: () => required("TELEGRAM_WEBHOOK_SECRET"),
  cronSecret: () => process.env.CRON_SECRET ?? "",
  groupChatId: () => process.env.GROUP_CHAT_ID ?? "",
  adminIds: () => ids("ADMIN_IDS"),

  databaseUrl: () => required("DATABASE_URL"),

  imapHost: () => required("IMAP_HOST"),
  imapPort: () => Number(process.env.IMAP_PORT ?? "993"),
  imapUser: () => required("IMAP_USER"),
  imapPassword: () => required("IMAP_PASSWORD"),
  imapFolder: () => process.env.IMAP_FOLDER ?? "INBOX",
  senderFilter: () => process.env.SENDER_FILTER ?? "",

  assignmentTimeoutMinutes: () => Number(process.env.ASSIGNMENT_TIMEOUT_MINUTES ?? "15"),
};
