import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { log, logError } from "./log.ts";

const run = promisify(execFile);

/** Bound so a hung CLI call becomes a tool error instead of a stuck turn. */
const TIMEOUT_MS = 30_000;

type LarkResult = { ok: true; data: unknown } | { ok: false; error: string };

/**
 * Feishu's own data (calendar, tasks, docs) is not part of the bot's scopes, but
 * `lark-cli` is already authenticated as the owner on this machine. Going through it
 * gives the agent the owner's view without widening the bot's permissions.
 */
async function lark(args: string[]): Promise<LarkResult> {
  try {
    const { stdout } = await run("lark-cli", [...args, "--format", "json"], {
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const text = stdout.trim();
    if (text.length === 0) return { ok: true, data: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // Some shortcuts print a human table even with --format json; hand the text back.
      return { ok: true, data: text };
    }
    const envelope = parsed as {
      ok?: boolean;
      data?: unknown;
      error?: { message?: string; hint?: string; missing_scopes?: string[] };
    };
    if (envelope.ok === false) {
      const detail = envelope.error ?? {};
      const scopes = detail.missing_scopes ?? [];
      // Surface the fix, not just the failure: the model can then tell the owner which
      // scope to authorize instead of reporting a dead end.
      const hint = scopes.length > 0 ? `\n缺权限：${scopes.join(", ")}\n${detail.hint ?? ""}` : "";
      return { ok: false, error: `${detail.message ?? "unknown error"}${hint}` };
    }
    if (envelope.ok === true) return { ok: true, data: envelope.data ?? null };
    return { ok: true, data: parsed };
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    const message = `${(error as Error).message}${stderr ? `: ${stderr.trim().slice(0, 300)}` : ""}`;
    logError("lark", `lark-cli ${args[0]} failed`, message);
    return { ok: false, error: message };
  }
}

function startOfToday(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function iso(date: Date): string {
  // Local ISO with offset, which the CLI accepts and keeps in the owner's timezone.
  const pad = (n: number) => String(n).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:00${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function summarize(data: unknown): string {
  if (data === null) return "（无数据）";
  if (typeof data === "string") return data.slice(0, 4000);
  const json = JSON.stringify(data, null, 1);
  return json.length > 6000 ? `${json.slice(0, 6000)}\n…（已截断）` : json;
}

const agenda = defineTool({
  name: "feishu_agenda",
  description: "看主人的飞书日历日程（默认今天，可指定往后几天）。用来回答'我今天有什么会'、安排时间。",
  parameters: obj({
    days: opt(num({ description: "从今天算起看几天，默认 1" })),
    start: opt(str({ description: "开始时间 ISO 8601，默认今天 00:00" })),
  }),
  replay: "safe",
  execute: async (args) => {
    const days = typeof args.days === "number" && args.days > 0 ? Math.min(args.days, 30) : 1;
    const start = args.start ? new Date(args.start) : startOfToday();
    const end = new Date(start.getTime() + days * 24 * 3600 * 1000);
    const result = await lark(["calendar", "+agenda", "--start", iso(start), "--end", iso(end)]);
    if (!result.ok) {
      return { output: [{ type: "text" as const, text: `读日历失败：${result.error}` }], isError: true };
    }
    log("lark", "agenda read", { days, events: Array.isArray(result.data) ? result.data.length : "?" });
    return { output: [{ type: "text" as const, text: summarize(result.data) }] };
  },
});

const tasks = defineTool({
  name: "feishu_tasks",
  description: "列出主人飞书里 assigned 给自己的任务（未完成的）。用来回答'我还欠什么'。",
  parameters: obj({}),
  replay: "safe",
  execute: async () => {
    const result = await lark(["task", "+get-my-tasks"]);
    if (!result.ok) {
      return { output: [{ type: "text" as const, text: `读任务失败：${result.error}` }], isError: true };
    }
    return { output: [{ type: "text" as const, text: summarize(result.data) }] };
  },
});

const createTask = defineTool({
  name: "feishu_create_task",
  description: "在飞书任务里给主人新建一条待办。会写到主人的真实任务列表里（需要审批）。",
  parameters: obj({
    summary: str({ description: "任务标题" }),
    due: opt(str({ description: "截止时间 ISO 8601，可选" })),
  }),
  execute: async (args) => {
    const cliArgs = ["task", "+create", "--summary", args.summary];
    if (typeof args.due === "string" && args.due.length > 0) cliArgs.push("--due", args.due);
    const result = await lark(cliArgs);
    if (!result.ok) {
      return { output: [{ type: "text" as const, text: `建任务失败：${result.error}` }], isError: true };
    }
    log("lark", "task created", args.summary);
    return { output: [{ type: "text" as const, text: `已建任务：${args.summary}\n${summarize(result.data)}` }] };
  },
});

const readDoc = defineTool({
  name: "feishu_doc_read",
  description: "读一篇飞书云文档的内容，参数可以是文档链接或 token。",
  parameters: obj({ url: str({ description: "文档 URL 或 token" }) }),
  replay: "safe",
  execute: async (args) => {
    const result = await lark(["docs", "+fetch", "--url", args.url]);
    if (!result.ok) {
      return { output: [{ type: "text" as const, text: `读文档失败：${result.error}` }], isError: true };
    }
    return { output: [{ type: "text" as const, text: summarize(result.data) }] };
  },
});

export const larkExtension = defineExtension({
  name: "feishu-native",
  tools: [agenda, tasks, createTask, readDoc],
});
