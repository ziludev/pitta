import { execFile } from "node:child_process";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { num, obj, opt, str } from "@earendil-works/pi-schema";
import { ChatPolicy, readRoots } from "./access.ts";
import { config } from "./config.ts";
import { log, logError } from "./log.ts";
import { listSkills } from "./skills.ts";

/**
 * The two read-only capabilities a colleague needs to ask about a problem — search the code,
 * look at the logs — without a shell. A prompt does not stop `cat .env`, and an allowlist of
 * shell commands does not either (`cat` reaches any path, `git show` any blob), so the blast
 * radius is fixed by the tool instead: one `rg` inside the chat's own project, and the
 * read-only SLS script that already exists on this machine.
 */

const run = promisify(execFile);
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 8_000;

/** Log stores are names like `app-dev-stdout`; anything else is a typo or an injection attempt. */
const LOGSTORE = /^[a-z0-9][a-z0-9-]{1,60}$/;
const ENVIRONMENTS = ["dev", "prod"] as const;
type Environment = (typeof ENVIRONMENTS)[number];

export type LogsQuery = {
  env: Environment;
  logstore: string;
  query: string;
  minutes: number;
  limit: number;
};

/** Validates and normalizes the arguments; returns why they are refused, or the query. */
export function parseLogsQuery(args: Record<string, unknown>): LogsQuery | string {
  const env = typeof args["env"] === "string" ? args["env"] : "dev";
  if (!ENVIRONMENTS.includes(env as Environment)) return `env 只能是 dev 或 prod，收到 "${env}"`;
  const logstore = typeof args["logstore"] === "string" && args["logstore"].length > 0
    ? args["logstore"]
    : `app-${env}-stdout`;
  if (!LOGSTORE.test(logstore)) return `logstore 名不合法："${logstore}"`;
  const query = typeof args["query"] === "string" ? args["query"].trim() : "";
  if (query.length === 0) return "query 不能为空";
  if (query.length > 500) return "query 太长（上限 500 字符）";
  const minutes = Math.min(1440, Math.max(1, Math.trunc(Number(args["minutes"] ?? 60)) || 60));
  const limit = Math.min(200, Math.max(1, Math.trunc(Number(args["limit"] ?? 50)) || 50));
  return { env: env as Environment, logstore, query, minutes, limit };
}

/** Production logs are the owner's call: a guest turn gets told so instead of the data. */
export function logsRefusedFor(env: Environment, guestTurn: boolean): string | undefined {
  if (env === "prod" && guestTurn) {
    return "生产日志只允许主人本人发起。要查 prod，让主人在私聊里问，或在群里由主人自己发。";
  }
  return undefined;
}

/** Where `project_search` may look: the same roots a guest read uses. */
export function searchRoot(
  args: Record<string, unknown>,
  roots: readonly string[],
): { ok: true; path: string } | { ok: false; reason: string } {
  const base = roots[0] ?? config.workspace;
  const raw = typeof args["path"] === "string" && args["path"].length > 0 ? args["path"] : "";
  const absolute = raw.length === 0 ? base : resolve(base, raw);
  const inside = roots.some((root) => {
    const resolved = resolve(root);
    return absolute === resolved || absolute.startsWith(`${resolved}/`);
  });
  return inside ? { ok: true, path: absolute } : { ok: false, reason: `不能再搜 ${raw}：只允许本会话所属项目和工作区。` };
}

function clip(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= MAX_OUTPUT ? trimmed : `${trimmed.slice(0, MAX_OUTPUT)}\n… （截断）`;
}

async function slsScript(): Promise<string | undefined> {
  const skill = (await listSkills().catch(() => [])).find((candidate) => candidate.name === "service-diagnose");
  return skill === undefined ? undefined : join(skill.dir, "scripts/sls.sh");
}

const logsQuery = defineTool({
  name: "logs_query",
  description:
    "查阿里云 SLS 日志（只读）。env 选 dev 或 prod，logstore 默认 app-<env>-stdout，query 用 SLS 查询语法（如 '\"2100083235\"' 或 'severity: ERROR and service: gateway'），minutes 是时间窗口（默认 60）。生产日志只有主人本人能查。",
  parameters: obj({
    query: str({ description: "SLS 查询语句" }),
    env: opt(str({ description: "dev 或 prod，默认 dev" })),
    logstore: opt(str({ description: "logstore 名，默认 app-<env>-stdout" })),
    minutes: opt(num({ description: "往前查多少分钟，默认 60，上限 1440" })),
    limit: opt(num({ description: "返回条数上限，默认 50，上限 200" })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const parsed = parseLogsQuery(args as Record<string, unknown>);
    if (typeof parsed === "string") return { output: [{ type: "text" as const, text: parsed }] };
    const policy = await api.snapshot(ChatPolicy, api.conversationId, context).catch(() => undefined);
    const guestTurn = policy?.guest === true && policy.turn !== "owner";
    const refused = logsRefusedFor(parsed.env, guestTurn);
    if (refused !== undefined) return { output: [{ type: "text" as const, text: refused }] };

    const script = await slsScript();
    if (script === undefined) {
      return { output: [{ type: "text" as const, text: "找不到 service-diagnose skill 的 scripts/sls.sh。" }] };
    }
    const argv = [
      script,
      "query",
      parsed.env,
      parsed.logstore,
      parsed.query,
      String(parsed.minutes),
      String(parsed.limit),
    ];
    log("logs", "sls query", { env: parsed.env, logstore: parsed.logstore, minutes: parsed.minutes, query: parsed.query });
    try {
      const { stdout } = await run("bash", argv, {
        timeout: TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        // The script itself refuses prod without this; the owner's turn is the only one that sets it.
        env: { ...process.env, ...(parsed.env === "prod" ? { INTERNAL_CONFIRM_PROD: "1" } : {}) },
      });
      const header = `[sls] env=${parsed.env} logstore=${parsed.logstore} 近 ${parsed.minutes} 分钟 query=${parsed.query}`;
      return { output: [{ type: "text" as const, text: `${header}\n${clip(stdout)}` }] };
    } catch (error) {
      logError("logs", "sls query failed", error);
      const detail = (error as { stderr?: string; message?: string }).stderr ?? (error as Error).message;
      return { output: [{ type: "text" as const, text: `日志查询失败：${clip(String(detail))}` }] };
    }
  },
});

const projectSearch = defineTool({
  name: "project_search",
  description:
    "在代码里搜索（只读，ripgrep）。pattern 是正则；path 默认本会话所属项目的根目录，只能搜这个项目或工作区内部。返回 文件:行号:内容。",
  parameters: obj({
    pattern: str({ description: "搜索的正则或字面量" }),
    path: opt(str({ description: "相对项目根的路径，默认项目根" })),
    max: opt(num({ description: "最多返回多少行匹配，默认 60，上限 200" })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const pattern = typeof args["pattern"] === "string" ? args["pattern"].trim() : "";
    if (pattern.length === 0) return { output: [{ type: "text" as const, text: "pattern 不能为空" }] };
    if (pattern.length > 300) return { output: [{ type: "text" as const, text: "pattern 太长（上限 300 字符）" }] };
    const roots = await readRoots(api, api.conversationId as unknown as number, context);
    const root = searchRoot(args as Record<string, unknown>, roots);
    if (!root.ok) return { output: [{ type: "text" as const, text: root.reason }] };
    const max = Math.min(200, Math.max(1, Math.trunc(Number(args["max"] ?? 60)) || 60));
    try {
      const { stdout } = await run(
        "rg",
        ["--line-number", "--no-heading", "--color", "never", "--max-count", String(max), "--", pattern, root.path],
        { timeout: TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024 },
      );
      log("search", "project search", { pattern, root: root.path, chars: stdout.length });
      return { output: [{ type: "text" as const, text: clip(stdout.length === 0 ? `没有匹配「${pattern}」。` : stdout) }] };
    } catch (error) {
      const failed = error as { code?: number; stderr?: string; message?: string };
      // rg exits 1 when nothing matched, which is a result, not a failure.
      if (failed.code === 1) {
        return { output: [{ type: "text" as const, text: `没有匹配「${pattern}」（${basename(root.path)}）。` }] };
      }
      logError("search", "project search failed", error);
      return { output: [{ type: "text" as const, text: `搜索失败：${clip(String(failed.stderr ?? failed.message))}` }] };
    }
  },
});

export const diagnosticsExtension = defineExtension({
  name: "diagnostics",
  tools: [logsQuery, projectSearch],
});
