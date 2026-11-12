import { defineExtension, defineTask, defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { notify, surfaceForConversation } from "./channel.ts";
import { logError } from "./log.ts";

export type ReminderInput = {
  /** What to say when it fires. */
  text: string;
  /** Epoch ms. */
  at: number;
  /** Where to deliver; resolved again at delivery time from the conversation. */
  surfaceId: string;
};

/**
 * A reminder is a durable task: it sleeps with a stored deadline, so it survives
 * restarts and process death. Nothing keeps a timer in memory while it waits.
 */
export const Reminder = defineTask<ReminderInput, { phase: "sleep" } | { phase: "deliver" }, string>({
  name: "app.reminder",
  version: 1,
  initial: () => ({ phase: "sleep" }),
  phases: {
    sleep: (task, runtime, context) =>
      runtime.sleepUntil(task.input.at, { phase: "deliver" }, context),
    deliver: async (task, runtime, context) => {
      const surfaceId = surfaceForConversation(task.conversationId) ?? task.input.surfaceId;
      // A surface that is not a chat (cli, a closed client chat) cannot receive the message.
      // A reminder that cannot be delivered must not fault the task: a fault retries the
      // phase, and a phase that keeps throwing loses the reminder without a word.
      let delivered = false;
      try {
        await notify(surfaceId, `⏰ 提醒：${task.input.text}`);
        delivered = true;
      } catch (error) {
        logError("reminders", `could not deliver reminder to ${surfaceId}`, error);
      }
      await runtime.commit(
        () => ({
          status: "terminal",
          outcome: { status: "completed", result: delivered ? "delivered" : "undeliverable" },
        }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(
      () => ({ status: "terminal", outcome: { status: "aborted" } }),
      context,
    ),
});

function formatLocal(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

const remind = defineTool({
  name: "remind",
  description:
    "设置一次性提醒，到点主动给 alex 发消息。用 in_minutes 表示几分钟后，或用 at 表示绝对时间（ISO 8601，如 2026-11-10T09:00:00+08:00）。",
  parameters: obj({
    text: str({ description: "提醒内容" }),
    in_minutes: opt(num({ description: "多少分钟后提醒" })),
    at: opt(str({ description: "绝对时间，ISO 8601" })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const now = api.now();
    let at: number;
    if (typeof args.in_minutes === "number" && args.in_minutes > 0) {
      at = now + args.in_minutes * 60_000;
    } else if (typeof args.at === "string" && args.at.length > 0) {
      const parsed = Date.parse(args.at);
      if (Number.isNaN(parsed)) {
        return { output: [{ type: "text" as const, text: `时间格式看不懂：${args.at}` }] };
      }
      at = parsed;
    } else {
      return { output: [{ type: "text" as const, text: "需要 in_minutes 或 at 其中一个" }] };
    }
    if (at <= now) {
      return { output: [{ type: "text" as const, text: "时间已经过去了" }] };
    }

    const surfaceId = surfaceForConversation(api.conversationId) ?? "";
    const taskId = await api.createTask(
      Reminder,
      { text: args.text, at, surfaceId },
      // Background: it outlives this turn, so the conversation goes idle while it waits.
      { ownership: { kind: "conversation" }, background: true },
      context,
    );
    return {
      output: [
        { type: "text" as const, text: `好的，${formatLocal(at)} 提醒你：${args.text}（task ${taskId}）` },
      ],
    };
  },
});

export const reminderExtension = defineExtension({ name: "reminders", tools: [remind], tasks: [Reminder] });
