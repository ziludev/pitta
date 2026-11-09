import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

/**
 * Loads `.env` with precedence over the ambient environment.
 * Node's `--env-file` never overrides an already-exported variable, so a stale
 * `FEISHU_APP_ID` in the shell silently pointed this bridge at another app.
 */
/** Credentials must follow .env: a stale exported app id silently pointed at another app. */
const ALWAYS_FROM_FILE = new Set(["FEISHU_APP_ID", "FEISHU_APP_SECRET"]);

function loadDotEnv(file = resolve(process.cwd(), ".env")): void {
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (key in process.env && !ALWAYS_FROM_FILE.has(key)) continue; // explicit env wins (tests, CI)
    let value = line.slice(eq + 1).trim();
    if (value.length >= 2 && /^(".*"|'.*')$/s.test(value)) value = value.slice(1, -1);
    process.env[key] = value;
  }
}

loadDotEnv();

function list(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return raw === "1" || raw.toLowerCase() === "true";
}

function num(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/** Absolute path helper: relative env values resolve against the process cwd. */
function path(name: string, fallback: string): string {
  const raw = process.env[name] || fallback;
  const expanded = raw.startsWith("~") ? `${homedir()}${raw.slice(1)}` : raw;
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded);
}

export const config = {
  feishu: {
    appId: process.env.FEISHU_APP_ID ?? "",
    appSecret: process.env.FEISHU_APP_SECRET ?? "",
    allowedChatIds: list("FEISHU_ALLOWED_CHAT_IDS"),
    allowedSenderIds: list("FEISHU_ALLOWED_SENDER_IDS"),
    mentionsOnly: bool("FEISHU_MENTIONS_ONLY", true),
    /** Group replies go into a thread so the group timeline stays readable. */
    replyInThread: bool("FEISHU_REPLY_IN_THREAD", true),
    /** Mention the asker in the reply, so it is clear who is being answered. */
    mentionSender: bool("FEISHU_MENTION_SENDER", true),
  },
  model: {
    provider: process.env.AGENT_PROVIDER ?? "magpie",
    // Pinned model id on purpose: routing groups (auto/*, group/*) pick a different
    // backend per request, which makes the same task succeed one day and fail the next.
    modelId: process.env.AGENT_MODEL ?? "vendor/deepseek-flash",
  },
  thinkingLevel: (process.env.AGENT_THINKING ?? "high") as
    | "off"
    | "minimal"
    | "low"
    | "medium"
    | "high"
    | "xhigh"
    | "max",
  workspace: path("AGENT_WORKSPACE", "./workspace"),
  dbPath: path("AGENT_DB", "./.data/agent.sqlite"),
  maxTurns: num("AGENT_MAX_TURNS", 40),
  /** USD per day; 0 or less means unlimited. */
  dailyBudgetUsd: num("AGENT_DAILY_BUDGET_USD", 0),
  /** MCP servers: JSON file with { "servers": { name: {...} } }. Empty = none. */
  mcpConfig: process.env.AGENT_MCP_CONFIG ?? "./mcp.json",
  /** Local client bridge (desktop app). Port 0 disables it. */
  http: {
    port: num("AGENT_HTTP_PORT", 8787),
    host: process.env.AGENT_HTTP_HOST ?? "127.0.0.1",
    token: process.env.AGENT_HTTP_TOKEN ?? "",
  },
  /** auto = one git worktree per conversation; off = everyone shares the workspace. */
  worktree: (process.env.AGENT_WORKTREE ?? "auto") as "auto" | "off",
  asr: {
    mode: (process.env.AGENT_ASR ?? "auto") as "auto" | "off",
    whisper: process.env.AGENT_ASR_WHISPER ?? "whisper",
    ffmpeg: process.env.AGENT_ASR_FFMPEG ?? "ffmpeg",
    model: process.env.AGENT_ASR_MODEL ?? "base",
    /** Explicit .pt path; skips the cache lookup (useful when the download lives elsewhere). */
    modelPath: process.env.AGENT_ASR_MODEL_PATH ?? "",
    language: process.env.AGENT_ASR_LANG ?? "zh",
  },
  magpie: {
    baseUrl: process.env.MAGPIE_BASE_URL ?? "http://127.0.0.1:3425/v1",
    apiKey: process.env.MAGPIE_API_KEY ?? "magpie",
  },
} as const;

export function requireFeishuCredentials(): { appId: string; appSecret: string } {
  const { appId, appSecret } = config.feishu;
  if (!appId || !appSecret) {
    throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET are required to run the Feishu bridge");
  }
  return { appId, appSecret };
}
