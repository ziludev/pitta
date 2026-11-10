/**
 * `agent` — the CLI half of the project. Talks to the running agent over its local
 * bridge, so it works while the desktop app and the Feishu bot are up; process-level
 * commands delegate to scripts/agentctl.
 */
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import { checkFeishu, type Check } from "./feishu-check.ts";

const HOME = process.env.PI_DURABLE_HOME ?? join(homedir(), "learn", "pi-durable-agent");
const ENV_FILE = join(HOME, ".env");

const c = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

function env(): Record<string, string> {
  const values: Record<string, string> = {};
  if (!existsSync(ENV_FILE)) return values;
  for (const line of readFileSync(ENV_FILE, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) values[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return values;
}

function baseURL(): string {
  const values = env();
  return `http://${values["AGENT_HTTP_HOST"] === undefined || values["AGENT_HTTP_HOST"] === "0.0.0.0" ? "127.0.0.1" : values["AGENT_HTTP_HOST"]}:${values["AGENT_HTTP_PORT"] ?? "8787"}`;
}

function token(): string {
  return env()["AGENT_HTTP_TOKEN"] ?? "";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const bearer = token();
  if (bearer.length > 0) headers["authorization"] = `Bearer ${bearer}`;
  const response = await fetch(`${baseURL()}${path}`, { ...init, headers });
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} → ${response.status}`);
  return (await response.json()) as T;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ---- commands ---------------------------------------------------------------

async function doctor(): Promise<void> {
  const values = env();
  console.log(c.bold("\n本地"));
  await new Promise<void>((resolve) => {
    execFile(join(HOME, "scripts", "doctor"), (error, stdout, stderr) => {
      process.stdout.write(stdout || stderr || (error === null ? "" : String(error)));
      resolve();
    });
  });

  console.log(c.bold("\n飞书"));
  const checks: Check[] = await checkFeishu(values["FEISHU_APP_ID"] ?? "", values["FEISHU_APP_SECRET"] ?? "");
  for (const check of checks) {
    const mark = check.level === "ok" ? c.green("✓") : check.level === "warn" ? c.yellow("!") : c.red("✗");
    console.log(`  ${mark} ${check.label}${check.hint === undefined ? "" : c.dim(`  → ${check.hint}`)}`);
  }
  const bad = checks.filter((check) => check.level === "bad").length;
  console.log(bad === 0 ? c.green("\n飞书侧没问题，可以启动了：./scripts/agentctl install\n") : c.red(`\n飞书侧还有 ${bad} 项要修\n`));
}

async function setup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const values = env();
  const ask = async (label: string, current: string | undefined, secret = false): Promise<string> => {
    const shown = current === undefined || current.length === 0 ? "" : secret ? c.dim("(已设置，回车保留)") : c.dim(`(${current})`);
    const answer = (await rl.question(`  ${label} ${shown}: `)).trim();
    return answer.length === 0 ? (current ?? "") : answer;
  };

  console.log(c.bold("\n飞书自建应用（开发者后台 → 凭证与基础信息）"));
  const appId = await ask("App ID", values["FEISHU_APP_ID"]);
  const appSecret = await ask("App Secret", values["FEISHU_APP_SECRET"], true);
  console.log(c.dim("  允许的会话/用户可以先留空，启动后按日志里的 id 再填；群里也可以发 /allow 自授权"));
  const chats = await ask("允许的 chat_id（逗号分隔）", values["FEISHU_ALLOWED_CHAT_IDS"]);
  const senders = await ask("允许的 open_id（逗号分隔）", values["FEISHU_ALLOWED_SENDER_IDS"]);
  rl.close();

  const merged = { ...values };
  merged["FEISHU_APP_ID"] = appId;
  merged["FEISHU_APP_SECRET"] = appSecret;
  merged["FEISHU_ALLOWED_CHAT_IDS"] = chats;
  merged["FEISHU_ALLOWED_SENDER_IDS"] = senders;
  const body = Object.entries(merged)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  writeFileSync(ENV_FILE, `${body}\n`, "utf8");
  console.log(c.green(`\n已写入 ${ENV_FILE}`));

  console.log(c.bold("\n检查"));
  const checks = await checkFeishu(appId, appSecret);
  for (const check of checks) {
    const mark = check.level === "ok" ? c.green("✓") : check.level === "warn" ? c.yellow("!") : c.red("✗");
    console.log(`  ${mark} ${check.label}${check.hint === undefined ? "" : c.dim(`  → ${check.hint}`)}`);
  }
}

type Conversation = { surfaceId: string; conversationId: number; kind?: string; title?: string; archived?: boolean };

async function ensureChat(surface: string): Promise<{ conversationId: number }> {
  const state = await api<{ surfaces: Conversation[] }>("/api/state");
  const existing = state.surfaces.find((item) => item.surfaceId === surface);
  if (existing !== undefined) return { conversationId: existing.conversationId };
  return await api<{ conversationId: number }>("/api/conversations", {
    method: "POST",
    body: JSON.stringify({ surfaceId: surface }),
  });
}

/** Streams one turn over the bridge: partial answer and tool names, then the result. */
async function turn(conversationId: number, text: string): Promise<string> {
  const ws = new WebSocket(
    `${baseURL().replace(/^http/, "ws")}/ws?conversationId=${conversationId}${
      token() ? `&token=${encodeURIComponent(token())}` : ""
    }`,
  );
  let lastTool = "";
  let lastPartial = "";

  ws.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as {
      value?: { docs?: Record<string, Record<string, unknown>> };
    };
    const live = frame.value?.docs?.["pi.live"];
    if (live === undefined) return;
    const tools = (live["tools"] as Array<Record<string, unknown>> | undefined) ?? [];
    const running = tools.find((slot) => slot["status"] === "running");
    const name = running === undefined ? "" : String(running["name"] ?? "");
    if (name.length > 0 && name !== lastTool) {
      lastTool = name;
      process.stdout.write(`\n  ${c.dim("⚙ " + name)}`);
    }
    const partial = textOfMessage(live["generation"]);
    if (partial.length > lastPartial.length) {
      lastPartial = partial;
      const tail = partial.slice(-90).replace(/\n/g, " ");
      process.stdout.write(`\r${c.dim(tail)}${" ".repeat(Math.max(0, 90 - tail.length))}`);
    }
  });
  await new Promise<void>((resolve) => {
    ws.on("open", () => resolve());
    ws.on("error", () => resolve());
  });

  const result = await api<{ status: string; answer?: string; reason?: string }>("/api/submit", {
    method: "POST",
    body: JSON.stringify({ conversationId, text, mode: "followUp", wait: true }),
  });
  ws.close();
  process.stdout.write("\r" + " ".repeat(100) + "\r");
  return result.status === "done" ? (result.answer ?? "") : `${c.dim("(未回答: " + (result.reason ?? result.status) + ")")}`;
}

/** Accepts a message, a message array, or a live generation record. */
function textOfMessage(input: unknown): string {
  const record = input as { content?: unknown; message?: unknown } | undefined;
  const target = record?.message ?? input;
  const list = Array.isArray(target) ? target : [target];
  const parts: string[] = [];
  for (const message of list) {
    const content = (message as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
      }
    }
  }
  return parts.join("");
}

async function ask(text: string): Promise<void> {
  const { conversationId } = await ensureChat("client:cli");
  const answer = await turn(conversationId, text);
  console.log(answer.length > 0 ? `\n${answer}\n` : c.dim("\n(没有回答)\n"));
}

async function chat(): Promise<void> {
  const { conversationId } = await ensureChat("client:cli");
  console.log(c.dim(`会话 #${conversationId} · /new 换上下文 · /stop 中断 · /exit 退出`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    let raw: string;
    try {
      raw = await rl.question(c.cyan("\n› "));
    } catch {
      // Ctrl-D / piped input ended: leave quietly instead of reporting an error.
      break;
    }
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line === "/exit" || line === "/quit") break;
    if (line === "/new") {
      await api("/api/reset", { method: "POST", body: JSON.stringify({ conversationId }) });
      console.log(c.dim("已开新上下文"));
      continue;
    }
    if (line === "/stop") {
      await api("/api/abort", { method: "POST", body: JSON.stringify({ conversationId }) });
      console.log(c.dim("已中断"));
      continue;
    }
    const answer = await turn(conversationId, line);
    console.log(`\n${answer}`);
  }
  rl.close();
}

async function sessions(): Promise<void> {
  const state = await api<{ projects: Array<{ id: string; name: string }>; surfaces: Conversation[] }>("/api/state");
  const projects = new Map(state.projects.map((project) => [project.id, project.name]));
  const rows = state.surfaces
    .filter((surface) => surface.archived !== true)
    .map((surface) => ({
      id: String(surface.conversationId),
      kind: surface.kind ?? "other",
      project: projects.get((surface as { projectId?: string }).projectId ?? "workspace") ?? "-",
      title: (surface.title ?? "").slice(0, 40),
    }));
  console.log(c.bold(`\n${rows.length} 个会话\n`));
  for (const row of rows.sort((a, b) => Number(a.id) - Number(b.id))) {
    console.log(`  ${row.id.padStart(5)}  ${row.kind.padEnd(7)} ${c.dim(row.project.padEnd(14))} ${row.title}`);
  }
  console.log();
}

async function approvals(action?: string, id?: string): Promise<void> {
  if (action === undefined) {
    const result = await api<{ approvals: Array<{ callId: string; tool: string; reason: string; summary: string }> }>(
      "/api/approvals",
    );
    if (result.approvals.length === 0) {
      console.log(c.dim("没有待审批"));
      return;
    }
    for (const entry of result.approvals) {
      console.log(`\n${c.yellow("⚠")} ${c.bold(entry.tool)} — ${entry.reason}`);
      console.log(c.dim(`  ${entry.summary.slice(0, 200)}`));
      console.log(c.dim(`  id: ${entry.callId}`));
    }
    console.log(c.dim("\nagent approve <id> / agent deny <id>"));
    return;
  }
  if (id === undefined) {
    console.error("用法: agent approve <id> | agent deny <id>");
    process.exit(2);
  }
  const result = await api<{ ok: boolean }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ callId: id, approved: action === "approve" }),
  });
  console.log(result.ok ? c.green(action === "approve" ? "已允许" : "已拒绝") : c.red("没找到这条审批（可能已超时）"));
}

function usage(): void {
  console.log(`${c.bold("agent")} — 个人助理的 CLI

${c.bold("开箱")}
  agent setup                写 .env（App ID/Secret/白名单）并立刻体检
  agent doctor               本地 + 飞书双侧体检，告诉你控制台还差什么

${c.bold("对话")}（走本机桥接，agent 在跑也能用）
  agent ask "…"              一次性提问
  agent chat                 交互式多轮（/new /stop /exit）
  agent sessions             列出会话

${c.bold("审批")}
  agent approvals            看待审批
  agent approve <id> | deny <id>

${c.bold("运维")}
  ./scripts/agentctl install|start|stop|restart|status|logs|doctor|backup|restore
`);
}

// ---- entry ------------------------------------------------------------------

const [command, ...rest] = process.argv.slice(2);
try {
  switch (command) {
    case "setup":
      await setup();
      break;
    case "doctor":
      await doctor();
      break;
    case "ask":
      if (rest.length === 0) throw new Error('用法: agent ask "你的问题"');
      await ask(rest.join(" "));
      break;
    case "chat":
      await chat();
      break;
    case "sessions":
      await sessions();
      break;
    case "approvals":
      await approvals();
      break;
    case "approve":
    case "deny":
      await approvals(command, rest[0]);
      break;
    case undefined:
    case "-h":
    case "--help":
    case "help":
      usage();
      break;
    default:
      console.error(`未知命令：${command}\n`);
      usage();
      process.exit(2);
  }
} catch (error) {
  console.error(c.red(`✗ ${(error as Error).message}`));
  process.exit(1);
}
