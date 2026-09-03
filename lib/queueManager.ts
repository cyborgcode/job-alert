import { config } from "./config";
import { db } from "./db";
import { telegram } from "./telegram";

export const CONFIRM_PREFIX = "job_confirm:";
export const REJECT_PREFIX = "job_reject:";

function jobMessage(subject: string, body: string, link: string | null): string {
  let text = `📢 New job alert\n\n<b>${subject}</b>\n\n${body}`;
  if (link) text += `\n\n${link}`;
  text += `\n\nYou're up in the queue. Confirm or reject within ${config.assignmentTimeoutMinutes()} minutes.`;
  return text;
}

export async function processJob(jobId: number): Promise<void> {
  const job = await db.getJob(jobId);
  if (!job || !["pending", "assigning"].includes(job.status)) return;

  const active = await db.getActiveAssignmentUserIds();
  const candidate = await db.popNextAvailable(active);

  if (!candidate) {
    await db.updateJobStatus(jobId, "pending");
    if (config.groupChatId()) {
      await telegram.sendMessage(
        config.groupChatId(),
        `⚠️ No one available in the queue right now for job:\n<b>${job.subject}</b>\nUse /queue to join and get considered for new jobs.`,
        { html: true }
      );
    }
    return;
  }

  const assignmentId = await db.createAssignment(jobId, candidate.user_id);
  await db.updateJobStatus(jobId, "assigning");

  try {
    await telegram.sendMessage(candidate.private_chat_id, jobMessage(job.subject, job.body, job.link), {
      html: true,
      keyboard: [
        [
          { text: "✅ Confirm", callback_data: `${CONFIRM_PREFIX}${assignmentId}` },
          { text: "❌ Reject", callback_data: `${REJECT_PREFIX}${assignmentId}` },
        ],
      ],
    });
  } catch {
    await db.updateAssignmentStatus(assignmentId, "undeliverable");
    await processJob(jobId);
    return;
  }

  if (config.groupChatId()) {
    const name = candidate.username ?? candidate.full_name ?? candidate.user_id;
    await telegram.sendMessage(
      config.groupChatId(),
      `📨 Job "${job.subject}" was sent to ${name}. Waiting for confirmation…`
    );
  }
}

export async function handleResponse(assignmentId: number, confirmed: boolean): Promise<string> {
  const assignment = await db.getAssignment(assignmentId);
  if (!assignment) return "This assignment no longer exists.";
  if (assignment.status !== "sent") return "This job has already been resolved.";

  const job = await db.getJob(assignment.job_id);
  if (!job) return "This job no longer exists.";

  if (confirmed) {
    await db.updateAssignmentStatus(assignmentId, "confirmed");
    await db.updateJobStatus(assignment.job_id, "completed");
    if (config.groupChatId()) {
      const member = await db.getMember(assignment.user_id);
      const name = member?.username ?? member?.full_name ?? assignment.user_id;
      await telegram.sendMessage(
        config.groupChatId(),
        `✅ ${name} confirmed and was assigned: <b>${job.subject}</b>`,
        { html: true }
      );
    }
    return "You're confirmed for this job. Good luck!";
  }

  await db.updateAssignmentStatus(assignmentId, "rejected");
  await db.addToQueue(assignment.user_id);
  if (config.groupChatId()) {
    await telegram.sendMessage(
      config.groupChatId(),
      `❌ Job "${job.subject}" was rejected, offering to the next person in the queue.`
    );
  }
  await processJob(assignment.job_id);
  return "You rejected the job. You've been moved to the end of the queue.";
}

export async function sweepTimeouts(): Promise<number> {
  const stale = await db.getStaleSentAssignments(config.assignmentTimeoutMinutes());

  for (const assignment of stale) {
    await db.updateAssignmentStatus(assignment.id, "timeout");
    await db.addToQueue(assignment.user_id);

    const member = await db.getMember(assignment.user_id);
    if (member?.private_chat_id) {
      try {
        await telegram.sendMessage(
          member.private_chat_id,
          "⌛ You didn't respond in time, so this job went to the next person in the queue. You've been moved to the end of the queue."
        );
      } catch {
        // best-effort notification only
      }
    }

    await processJob(assignment.job_id);
  }

  return stale.length;
}
