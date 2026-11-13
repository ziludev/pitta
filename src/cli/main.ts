/**
 * `agent` — the CLI half of the project. Talks to the running agent over its local
 * bridge, so it works while the desktop app and the Feishu bot are up; process-level
 * commands delegate to scripts/agentctl.
 */
import { execFile, execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import WebSocket from "ws";
import { checkFeishu, type Check } from "./feishu-check.ts";
import { renderEnv } from "./env-file.ts";
import { formatEvent, type AuditEvent } from "../audit.ts";

// Resolved from this file so a checkout in any directory works; PI_DURABLE_HOME overrides.
const PROJECT = process.env.PI_DURABLE_HOME ?? join(import.meta.dirname, "..", "..");
const HOME = PROJECT;
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
  const checks: Check[] = await checkFeishu(
    values["FEISHU_APP_ID"] ?? "",
    values["FEISHU_APP_SECRET"] ?? "",
    (values["FEISHU_ALLOWED_SENDER_IDS"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  for (const check of checks) {
    const mark = check.level === "ok" ? c.green("✓") : check.level === "warn" ? c.yellow("!") : c.red("✗");
    console.log(`  ${mark} ${check.label}${check.hint === undefined ? "" : c.dim(`  → ${check.hint}`)}`);
  }
  console.log(c.bold("\n权限"));
  try {
    printAccess(await api<AccessView>("/api/access"));
  } catch {
    console.log(c.dim("  agent 没在跑：启动后 `durable access` 查看每个会话的级别"));
  }

  const bad = checks.filter((check) => check.level === "bad").length;
  console.log(bad === 0 ? c.green("\n飞书侧没问题，可以启动了：./scripts/agentctl install\n") : c.red(`\n飞书侧还有 ${bad} 项要修\n`));
}

/** Steps a stranger needs, in the order the console asks for them. */
const PROVIDERS: Array<{ id: string; label: string; key: string; model: string }> = [
  { id: "deepseek", label: "DeepSeek", key: "DEEPSEEK_API_KEY", model: "deepseek-chat" },
  { id: "openai", label: "OpenAI", key: "OPENAI_API_KEY", model: "gpt-5" },
  { id: "anthropic", label: "Anthropic", key: "ANTHROPIC_API_KEY", model: "claude-sonnet-4-5" },
  { id: "magpie", label: "magpie 本机代理（OpenAI 兼容，127.0.0.1:3425）", key: "MAGPIE_API_KEY", model: "" },
];

async function setup(): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const values = env();
  // Piped input is served from a queue: readline's close event would otherwise cancel the
  // remaining questions even though their answers were already written to the pipe.
  const piped = process.stdin.isTTY ? undefined : readFileSync(0, "utf8").split("\n");
  let cursor = 0;
  const ask = async (label: string, current: string | undefined, secret = false): Promise<string> => {
    const shown =
      current === undefined || current.length === 0 ? "" : secret ? c.dim("(已设置，回车保留)") : c.dim(`(${current})`);
    let raw: string;
    if (piped === undefined) {
      raw = await rl.question(`  ${label} ${shown}: `);
    } else {
      raw = piped[cursor++] ?? "";
      console.log(`  ${label} ${shown}: ${secret ? c.dim("…") : raw}`);
    }
    const answer = raw.trim();
    return answer.length === 0 ? (current ?? "") : answer;
  };

  console.log(c.bold("\ndurable setup — 把 agent 跑起来\n"));
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    console.log(c.red(`  ✗ 需要 Node 22+，当前 ${process.versions.node}`));
    rl.close();
    process.exit(1);
  }
  console.log(c.green(`  ✓ Node ${process.versions.node}`));

  if (!existsSync(join(HOME, "node_modules"))) {
    console.log(c.dim("  安装依赖（npm install）…"));
    execFileSync("npm", ["install"], { cwd: HOME, stdio: "inherit" });
  }
  console.log(c.green("  ✓ 依赖就绪"));

  console.log(c.bold("\n模型网关"));
  PROVIDERS.forEach((entry, index) => console.log(`  ${index + 1}) ${entry.label}`));
  const picked = (await ask(`选择 1-${PROVIDERS.length}`, "1")).trim();
  const provider = PROVIDERS[Math.max(0, Number(picked) - 1)] ?? PROVIDERS[0]!;
  if (provider.id === "magpie") {
    const baseUrl = await ask("网关地址", values["MAGPIE_BASE_URL"] ?? "http://127.0.0.1:3425/v1");
    const model = await ask("模型 id（Agent 页里选的那个，如 vendor/model-name）", values["AGENT_MODEL"]);
    values["MAGPIE_BASE_URL"] = baseUrl;
    values["MAGPIE_API_KEY"] = await ask("网关 key", values["MAGPIE_API_KEY"] ?? "magpie", true);
    values["AGENT_MODEL"] = model;
  } else {
    const model = await ask(`模型 id`, values["AGENT_MODEL"] ?? provider.model);
    const key = await ask(`${provider.key}`, values[provider.key], true);
    if (key.length === 0) {
      console.log(c.yellow(`  ! 没填 ${provider.key}，这一轮跑不起来；可以之后写进 .env`));
    }
    values[provider.key] = key;
    values["AGENT_MODEL"] = model;
  }
  values["AGENT_PROVIDER"] = provider.id;

  console.log(c.bold("\n飞书自建应用") + c.dim("（开发者后台 → 凭证与基础信息）"));
  values["FEISHU_APP_ID"] = await ask("App ID", values["FEISHU_APP_ID"]);
  values["FEISHU_APP_SECRET"] = await ask("App Secret", values["FEISHU_APP_SECRET"], true);
  console.log(c.dim("  允许的 chat_id 可以先留空，启动后按日志里的 id 再填；群里也能发 /allow 自授权"));
  console.log(c.dim("  允许的 open_id 必须填：留空等于把群里每个人都当成主人，能点审批、能改代码"));
  values["FEISHU_ALLOWED_CHAT_IDS"] = await ask("允许的 chat_id（逗号分隔）", values["FEISHU_ALLOWED_CHAT_IDS"]);
  values["FEISHU_ALLOWED_SENDER_IDS"] = await ask("你的 open_id（逗号分隔）", values["FEISHU_ALLOWED_SENDER_IDS"]);

  const existing = existsSync(ENV_FILE) ? readFileSync(ENV_FILE, "utf8") : "";
  writeFileSync(ENV_FILE, renderEnv(existing, values), "utf8");
  console.log(c.green(`\n已写入 ${ENV_FILE}`) + c.dim("（你手写的注释和其他键都保留）"));

  console.log(c.bold("\n体检"));
  const checks = await checkFeishu(
    values["FEISHU_APP_ID"] ?? "",
    values["FEISHU_APP_SECRET"] ?? "",
    (values["FEISHU_ALLOWED_SENDER_IDS"] ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
  const mark = (level: string): string =>
    level === "ok" ? c.green("✓") : level === "warn" ? c.yellow("!") : c.red("✗");
  for (const check of checks) {
    console.log(`  ${mark(check.level)} ${check.label}${check.hint === undefined ? "" : c.dim(`  → ${check.hint}`)}`);
  }
  const blocked = checks.some((check) => check.level === "bad");

  console.log(c.bold("\n启动"));
  const answer = (await ask("交给 launchd 托管（开机自启、崩溃重启）？[Y/n]", "y")).trim().toLowerCase();
  rl.close();
  if (answer !== "n" && answer !== "no") {
    try {
      execFileSync("./scripts/agentctl", ["install"], { cwd: HOME, stdio: "inherit" });
      console.log(c.dim("  日志：./scripts/agentctl logs    状态：./scripts/agentctl status"));
    } catch (error) {
      console.log(c.yellow(`  ! launchd 没装上：${(error as Error).message}`));
      console.log(c.dim("    在仓库根目录手动跑一次：./scripts/agentctl install（仅 macOS）"));
    }
  } else {
    console.log(c.dim(`  前台跑：npm start（或 ./scripts/agentctl start）`));
  }

  console.log(
    blocked
      ? c.yellow("\n还有 ✗ 项没解决，按上面的提示在控制台改完再重启：./scripts/agentctl restart")
      : c.green("\n好了。在飞书里给机器人发一条消息，或在终端 durable ask \"你好\""),
  );
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
    console.error("用法: durable approve <id> | durable deny <id>");
    process.exit(2);
  }
  const result = await api<{ ok: boolean }>("/api/approvals", {
    method: "POST",
    body: JSON.stringify({ callId: id, approved: action === "approve" }),
  });
  console.log(result.ok ? c.green(action === "approve" ? "已允许" : "已拒绝") : c.red("没找到这条审批（可能已超时）"));
}

function usage(): void {
  console.log(`${c.bold("durable")} — 个人助理的 CLI

${c.bold("开箱")}
  durable setup                引导式安装：依赖、模型网关、飞书凭据、体检、launchd
  durable doctor               本地 + 飞书双侧体检，告诉你控制台还差什么

${c.bold("对话")}（走本机桥接，agent 在跑也能用）
  durable ask "…"              一次性提问
  durable chat                 交互式多轮（/new /stop /exit）
  durable sessions             列出会话

${c.bold("权限")}
  durable access               每个会话的访问级别（closed / owner / group）
  durable access set <chat> <level>
                               改某个会话的访问级别（owner=只有你）
  durable audit [n]            最近 n 条权限决定（默认 30）
  durable trace [n]            最近 n 次运行的 span（默认 15，看哪一步慢）

${c.bold("审批")}
  durable approvals            看待审批
  durable approve <id> | deny <id>

${c.bold("运维")}
  ./scripts/agentctl install|start|stop|restart|status|logs|doctor|backup|restore
`);
}

type AccessRow = { chatId: string; level: string; conversationId?: number; title?: string };
type AccessView = { chats: AccessRow[]; envChats: string[]; ownerChat?: string };

function levelMark(level: string): string {
  if (level === "group") return c.yellow("group ");
  if (level === "owner") return c.green("owner ");
  return c.dim("closed");
}

function printAccess(data: AccessView): void {
  if (data.chats.length === 0) {
    console.log(c.dim("  （还没有任何会话级别；有人找 bot 时会给你发一张开放卡）"));
    return;
  }
  for (const row of data.chats) {
    const title = row.title === undefined || row.title.length === 0 ? "" : `  ${row.title}`;
    const conv = row.conversationId === undefined ? "" : c.dim(`  conv ${row.conversationId}`);
    console.log(`  ${levelMark(row.level)}  …${row.chatId.slice(-8)}${title}${conv}`);
  }
  const env = data.envChats.length === 0 ? "无" : data.envChats.map((id) => `…${id.slice(-8)}`).join(", ");
  console.log(c.dim(`\n  .env 里列的 chat（默认 owner 级别）：${env}`));
  console.log(
    c.dim(
      `  审批卡发往：${
        data.ownerChat === undefined ? "未记录（先在私聊里给 bot 发一句）" : `…${data.ownerChat.slice(-8)}`
      }`,
    ),
  );
}

async function access(): Promise<void> {
  printAccess(await api<AccessView>("/api/access"));
}

async function accessSet(chatId: string | undefined, level: string | undefined): Promise<void> {
  if (chatId === undefined || level === undefined) throw new Error("用法: durable access set <chatId> <closed|owner|group>");
  const data = await api<{ chatId: string; level: string }>("/api/access", {
    method: "POST",
    body: JSON.stringify({ chatId, level }),
  });
  console.log(c.green(`已将 …${data.chatId.slice(-8)} 设为 ${data.level}`));
}

async function audit(limit = 30): Promise<void> {
  const data = await api<{ events: AuditEvent[] }>(`/api/audit?limit=${limit}`);
  if (data.events.length === 0) {
    console.log(c.dim("还没记录任何决定。"));
    return;
  }
  for (const event of data.events) console.log(formatEvent(event));
}

async function trace(limit: number): Promise<void> {
  const { readTraces } = await import("../telemetry.ts");
  const rows = await readTraces(join(HOME, ".data", "agent.sqlite"), limit).catch((error: unknown) => {
    console.error(c.red(`读不到 trace：${(error as Error).message}`));
    return [];
  });
  if (rows.length === 0) {
    console.log(c.dim("还没有记录任何 trace（首批 span 在 agent 重启后产生）"));
    return;
  }
  for (const row of rows) {
    const when = new Date(row.startedMs).toLocaleTimeString("zh-CN", { hour12: false });
    const badge = row.errors > 0 ? c.red("error") : c.dim("ok   ");
    console.log(
      `${when}  ${badge}  ${String(row.ms).padStart(7)}ms  ${String(row.spans).padStart(3)} spans  ${row.name}`,
    );
  }
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
      if (rest.length === 0) throw new Error('用法: durable ask "你的问题"');
      await ask(rest.join(" "));
      break;
    case "chat":
      await chat();
      break;
    case "sessions":
      await sessions();
      break;
    case "access":
      if (rest[0] === "set") await accessSet(rest[1], rest[2]);
      else await access();
      break;
    case "audit":
      await audit(rest[0] === undefined ? 30 : Math.max(1, Number(rest[0]) || 30));
      break;
    case "trace":
      await trace(rest[0] === undefined ? 15 : Math.max(1, Number(rest[0]) || 15));
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
