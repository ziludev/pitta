import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import { UsageDoc, type Conversation } from "@earendil-works/pi-durable";
import { ChatsToken, context, type AgentRuntime } from "./harness.ts";
import { getFeishuStatus } from "./feishu.ts";
import { log, logError } from "./log.ts";
import { config } from "./config.ts";
import { collectChanges, commitChanges, ensureRepo } from "./changes.ts";
import { mergeWorktree } from "./worktree.ts";
import { listApprovals, resolveApproval } from "./approvals.ts";
import { surfaceMeta, updateSurfaceMeta } from "./surface-meta.ts";
import { removeWorktree, worktreePaths } from "./worktree.ts";
import { branches, commitDiff, commitLog, compareUrl, pushBranch, remoteInfo } from "./git-info.ts";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { ChatMemory, GlobalMemory, WorkMemory } from "./memory.ts";

/**
 * Local HTTP + WebSocket bridge so a desktop client is just another watcher.
 *
 * It runs inside the agent process on purpose: one storage, one writer. The client
 * never opens SQLite; it subscribes to `conversation.watch()` and posts input.
 */

type Json = Record<string, unknown>;

function bearer(req: IncomingMessage): string {
  const header = req.headers["authorization"];
  if (typeof header === "string" && header.startsWith("Bearer ")) return header.slice(7);
  const alt = req.headers["x-agent-token"];
  return typeof alt === "string" ? alt : "";
}

function tokenMatches(given: string): boolean {
  const expected = config.http.token;
  if (expected.length === 0) return true;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    // The client is a local app; allow it to call from a WebView origin.
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "authorization, content-type, x-agent-token",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  });
  res.end(payload);
}

/** A line of text that says what a background task is about, when it has one. */
function taskTitle(kind: string, input: unknown): string | undefined {
  const value = input as { text?: string; spec?: string } | undefined;
  if (kind === "app.reminder" && typeof value?.text === "string") return value.text;
  if (kind === "app.feature" && typeof value?.spec === "string") return value.spec.replace(/\s+/g, " ").slice(0, 60);
  return undefined;
}

/** Plain text of one entry's messages, for search snippets. */
function entryText(model: unknown): string {
  const messages = Array.isArray(model) ? (model as Array<Record<string, unknown>>) : [];
  const parts: string[] = [];
  for (const message of messages) {
    const content = message["content"];
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
        else if (part["type"] === "thinking" && typeof part["thinking"] === "string") parts.push(part["thinking"]);
        else if (part["type"] === "toolCall") parts.push(`[${String(part["name"] ?? "tool")}]`);
      }
    }
    if (typeof message["toolName"] === "string") parts.push(`[${message["toolName"]}]`);
  }
  return parts.join("\n");
}

async function execGit(dir: string, args: string[]): Promise<string> {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("git", ["-C", dir, ...args]);
  return stdout;
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk as Buffer));
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text.length === 0) return {};
  try {
    return JSON.parse(text) as Json;
  } catch {
    return {};
  }
}

function conversationIdOf(value: Json): number | undefined {
  const raw = value["conversationId"];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim().length > 0) return Number(raw);
  return undefined;
}

export type AgentServer = { port: number; close(): Promise<void> };

export async function startAgentServer(runtime: AgentRuntime): Promise<AgentServer> {
  const { port, host } = config.http;
  if (port <= 0) {
    return { port: 0, close: async () => {} };
  }

  const resolveConversation = async (id: number | undefined): Promise<Conversation | undefined> => {
    if (id === undefined) return undefined;
    const conversation = await runtime.harness.conversation(id as never, context);
    // A client submission must still resolve its surface, or an approval raised by
    // that run would have nowhere to go.
    if (conversation !== undefined) await runtime.attachSurface(id).catch(() => {});
    return conversation;
  };

  /** The directory a conversation works in: its worktree, or the shared workspace. */
  const dirFor = async (conversationId: number | undefined): Promise<string> => {
    const conversation = await resolveConversation(conversationId);
    if (conversation === undefined) return config.workspace;
    const agent = await conversation.agent(context).catch(() => undefined);
    return agent?.cwd ?? config.workspace;
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const path = url.pathname;

      if (!tokenMatches(bearer(req))) return send(res, 401, { error: "unauthorized" });

      /** How many human turns a chat has had, for "average cost per turn". */
      const countTurns = async (conversationId: number): Promise<number> => {
        const conversation = await runtime.harness.conversation(conversationId as never, context).catch(() => undefined);
        if (conversation === undefined) return 0;
        let cursor: unknown;
        let turns = 0;
        // Bounded: a conversation longer than 6000 entries reports what it counted.
        for (let page = 0; page < 12; page += 1) {
          const result = await conversation
            .entries({ order: "ascending" }, 500, cursor as never, context)
            .catch(() => undefined);
          if (result === undefined) break;
          turns += result.items.filter((entry) => entry.kind === "pi.user").length;
          cursor = result.next;
          if (cursor === undefined) break;
        }
        return turns;
      };

      /** Per-conversation spend, straight from the usage ledger the harness keeps. */
      const usageOf = async (conversationId: number): Promise<{ cost: number; tokens: number }> => {
        const ledger = await runtime.harness.snapshot(UsageDoc, conversationId as never, context).catch(() => undefined);
        let cost = 0;
        let tokens = 0;
        const add = (bucket: unknown): void => {
          const entry = bucket as { cost?: { total?: number }; totalTokens?: number };
          cost += entry.cost?.total ?? 0;
          tokens += entry.totalTokens ?? 0;
        };
        for (const bucket of Object.values(ledger?.models ?? {})) add(bucket);
        for (const bucket of Object.values(ledger?.tools ?? {})) add(bucket);
        return { cost, tokens };
      };

      if (req.method === "GET" && path === "/api/state") {
        const [inspection, usage, projects] = await Promise.all([
          runtime.harness.inspect(context),
          runtime.harness.usage(context),
          runtime.projects(),
        ]);
        const chats = (await runtime.harness.snapshot(ChatsToken, context).catch(() => undefined)) as
          | { chats: Record<string, number> }
          | undefined;
        const meta: Record<string, { title?: string; archived?: boolean }> = await surfaceMeta(
          runtime.harness,
          context,
        ).catch(() => ({}));
        type ThreadInfo = { key: string; parent?: number; surfaceId?: string };
        const threads: Record<string, ThreadInfo> = await runtime.threads().catch((error: unknown) => {
          logError("server", "could not read thread index", error);
          return {} as Record<string, ThreadInfo>;
        });
        const entries = Object.entries(chats?.chats ?? {});
        const surfaces = await Promise.all(
          entries.map(async ([surfaceId, conversationId]) => {
            const kind = surfaceId.startsWith("oc_") ? "feishu" : surfaceId.startsWith("client:") ? "client" : "other";
            const conversation = await runtime.harness
              .conversation(conversationId as never, context)
              .catch(() => undefined);
            const title =
              conversation === undefined
                ? ""
                : await conversation
                    .entries({ order: "ascending" }, 12, undefined, context)
                    .then((page) => {
                      const first = page.items.find((entry) => entry.kind === "pi.user");
                      const text = first === undefined ? "" : entryText(first.model);
                      // A title, not a transcript: collapse whitespace, drop a leading
                      // mention, and cut where a human would still recognise it.
                      return text.replace(/\s+/g, " ").replace(/^@\s*/, "").trim().slice(0, 32);
                    })
                    .catch(() => "");
            const own = meta[surfaceId];
            const spend = await usageOf(conversationId).catch(() => ({ cost: 0, tokens: 0 }));
            const thread = threads[String(conversationId)];
            return {
              surfaceId,
              conversationId,
              kind,
              // A forked topic: the client nests it under the chat it branched from.
              threadKey: thread?.key,
              threadParent: thread?.parent,
              cost: spend.cost,
              tokens: spend.tokens,
              title: own?.title ?? title,
              archived: own?.archived === true,
              projectId: await runtime.projectOfConversation(conversationId as unknown as number).catch(() => undefined),
            };
          }),
        );
        // A topic fork shares its parent's surface, so the chat map only ever names the
        // parent. List the forks too, or the client cannot read what the bot said in a
        // topic at all.
        const listed = new Set(surfaces.map((surface) => surface.conversationId));
        for (const [id, info] of Object.entries(threads)) {
          const conversationId = Number(id);
          if (listed.has(conversationId) || info.surfaceId === undefined) continue;
          const conversation = await runtime.harness
            .conversation(conversationId as never, context)
            .catch(() => undefined);
          if (conversation === undefined) continue;
          // A topic inherits its chat's history, so its first user message is the parent's
          // question. Title it by the latest ask instead, which is what the topic is about.
          const title = await conversation
            .entries({ order: "descending" }, 40, undefined, context)
            .then((page) => {
              const last = page.items.find((entry) => entry.kind === "pi.user");
              const text = last === undefined ? "" : entryText(last.model);
              return text.replace(/\s+/g, " ").replace(/^@\s*/, "").trim().slice(0, 32);
            })
            .catch(() => "");
          const spend = await usageOf(conversationId).catch(() => ({ cost: 0, tokens: 0 }));
          const own = meta[info.surfaceId];
          surfaces.push({
            surfaceId: info.surfaceId,
            conversationId,
            kind: "feishu",
            threadKey: info.key,
            threadParent: info.parent,
            cost: spend.cost,
            tokens: spend.tokens,
            title: title.length > 0 ? title : `话题 ${info.key.slice(-6)}`,
            archived: own?.archived === true,
            projectId: await runtime.projectOfConversation(conversationId).catch(() => undefined),
          });
        }

        return send(res, 200, {
          feishu: getFeishuStatus(),
          projects,
          surfaces,
          tasks: inspection.tasks.map((task) => ({
            id: task.record.id,
            kind: task.record.kind,
            conversationId: task.record.conversationId,
            background: task.record.background === true,
            state: (task.state as unknown as { kind?: string }).kind ?? "?",
            // Sleeping tasks know when they wake; reminders carry their own text.
            until: (task.state as unknown as { until?: number }).until,
            title: taskTitle(task.record.kind, task.record.input),
          })),
          usage,
        });
      }

      if (req.method === "GET" && path === "/api/projects") {
        return send(res, 200, { projects: await runtime.projects() });
      }

      if (req.method === "POST" && path === "/api/projects") {
        const body = await readJson(req);
        const raw = typeof body["path"] === "string" ? (body["path"] as string).trim() : "";
        if (raw.length === 0) return send(res, 400, { error: "path required" });
        const result = await runtime.addProject(raw);
        return send(res, result.status === "added" || result.status === "exists" ? 200 : 400, result);
      }

      if (req.method === "POST" && path === "/api/projects/remove") {
        const body = await readJson(req);
        const id = typeof body["id"] === "string" ? (body["id"] as string).trim() : "";
        if (id.length === 0) return send(res, 400, { error: "id required" });
        const result = await runtime.removeProject(id);
        if (result.status === "missing") return send(res, 404, result);
        if (result.status === "builtin") return send(res, 400, result);
        return send(res, 200, result);
      }

      if (req.method === "POST" && path === "/api/surface-meta") {
        const body = await readJson(req);
        const conversationId = conversationIdOf(body);
        const surfaceId =
          typeof body["surfaceId"] === "string" && body["surfaceId"].length > 0
            ? (body["surfaceId"] as string)
            : conversationId === undefined
              ? undefined
              : await runtime.surfaceOf(conversationId);
        if (surfaceId === undefined) return send(res, 400, { error: "surfaceId or conversationId required" });
        const title = "title" in body ? (body["title"] === null ? null : String(body["title"])) : undefined;
        const archived = typeof body["archived"] === "boolean" ? (body["archived"] as boolean) : undefined;
        await updateSurfaceMeta(runtime.harness, context, surfaceId, { title, archived });
        return send(res, 200, { ok: true, surfaceId });
      }

      if (req.method === "POST" && path === "/api/worktree/remove") {
        const body = await readJson(req);
        const conversationId = conversationIdOf(body);
        if (conversationId === undefined) return send(res, 400, { error: "conversationId required" });
        const force = body["force"] === true;
        const result = await removeWorktree(await runtime.projectPathOf(conversationId), conversationId, {
          force,
          base: await runtime.baseBranchOf(conversationId),
        });
        // The conversation and its transcript stay: only the checkout is gone. Point it
        // back at the shared workspace so the chat keeps working instead of failing
        // every tool call on a missing cwd.
        if (result.status === "removed" || result.status === "absent") {
          const conversation = await resolveConversation(conversationId);
          await conversation?.configure({ cwd: config.workspace }, context).catch(() => {});
        }
        return send(res, 200, { ...result, conversationId });
      }

      if (req.method === "POST" && path === "/api/conversations") {
        const body = await readJson(req);
        const requested = typeof body["surfaceId"] === "string" ? (body["surfaceId"] as string) : "";
        // Client chats get their own namespace so they never collide with Feishu ids.
        const surfaceId = requested.startsWith("client:") ? requested : `client:${Date.now().toString(36)}`;
        const projectId = typeof body["projectId"] === "string" ? (body["projectId"] as string) : undefined;
        const conversation = await runtime.newConversation(surfaceId, projectId);
        return send(res, 200, { conversationId: conversation.id as unknown as number, surfaceId });
      }

      if (req.method === "GET" && path === "/api/models") {
        const [models, fallback] = await Promise.all([
          Promise.resolve(runtime.models()),
          runtime.defaultModel().catch(() => undefined),
        ]);
        return send(res, 200, {
          models,
          default: fallback ?? { provider: config.model.provider, modelId: config.model.modelId },
        });
      }

      if (req.method === "POST" && path === "/api/default-model") {
        const body = await readJson(req);
        const provider = typeof body["provider"] === "string" ? body["provider"] : "";
        const modelId = typeof body["modelId"] === "string" ? body["modelId"] : "";
        if (provider.length === 0 || modelId.length === 0) return send(res, 400, { error: "provider and modelId required" });
        const thinkingLevel = typeof body["thinkingLevel"] === "string" ? body["thinkingLevel"] : undefined;
        await runtime.setDefaultModel({ provider, modelId, thinkingLevel });
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/api/model") {
        const body = await readJson(req);
        const conversation = await resolveConversation(conversationIdOf(body));
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        const provider = typeof body["provider"] === "string" ? body["provider"] : "";
        const modelId = typeof body["modelId"] === "string" ? body["modelId"] : "";
        if (provider.length === 0 || modelId.length === 0) return send(res, 400, { error: "provider and modelId required" });
        const thinkingLevel = typeof body["thinkingLevel"] === "string" ? body["thinkingLevel"] : undefined;
        await runtime.setModel(conversation, { provider, modelId, thinkingLevel });
        log("http", "model switched", { conversationId: conversationIdOf(body), provider, modelId, thinkingLevel });
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && path === "/api/usage-calendar") {
        const days = Math.min(Number(url.searchParams.get("days") ?? 120) || 120, 365);
        const calendar = await runtime.usageCalendar(days);
        return send(res, 200, { days: calendar });
      }

      if (req.method === "GET" && path === "/api/conversation") {
        const id = Number(url.searchParams.get("id"));
        const conversation = await resolveConversation(Number.isFinite(id) ? id : undefined);
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        // Newest N, then flipped: `limit` must cut the tail, not the head.
        const limit = Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500);
        const page = await conversation.entries({ order: "descending" }, limit, undefined, context);
        const newestFirst = [...page.items].reverse();
        const agent = await conversation.agent(context).catch(() => undefined);
        const waits = await runtime.approvalWaits(conversation.id as unknown as number).catch(() => []);
        const spend = await usageOf(conversation.id as unknown as number).catch(() => ({ cost: 0, tokens: 0 }));
        return send(res, 200, {
          conversationId: conversation.id as unknown as number,
          approvalWaits: waits,
          usage: { ...spend, turns: await countTurns(conversation.id as unknown as number) },
          model: agent?.model ?? null,
          thinkingLevel: agent?.thinkingLevel ?? null,
          entries: newestFirst.map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            model: entry.model ?? null,
            data: entry.data ?? null,
          })),
        });
      }

      if (req.method === "POST" && path === "/api/submit") {
        const body = await readJson(req);
        const conversation = await resolveConversation(conversationIdOf(body));
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        const text = typeof body["text"] === "string" ? body["text"] : "";
        const images = Array.isArray(body["images"])
          ? (body["images"] as Array<{ data?: string; mimeType?: string }>)
              .filter((image) => typeof image?.data === "string")
              .slice(0, 3)
              .map((image) => ({
                type: "image" as const,
                data: image.data as string,
                mimeType: typeof image.mimeType === "string" ? image.mimeType : "image/png",
              }))
          : [];
        if (text.trim().length === 0 && images.length === 0) return send(res, 400, { error: "empty text" });
        const mode = body["mode"];
        const whenBusy = mode === "steer" ? "steer" : mode === "reject" ? "reject" : "followUp";
        const content =
          images.length === 0
            ? text
            : [{ type: "text" as const, text: text.length > 0 ? text : "看看这几张图。" }, ...images];
        const submission = await conversation.submit({ type: "input", content, whenBusy }, context);
        // The CLI has no reliable way to know when a run ended otherwise; let it wait
        // here rather than poll the view for a busy/idle transition it can miss.
        if (body["wait"] === true) {
          const settled = await submission.wait(context);
          const answer =
            settled.status === "done" && settled.answer !== undefined
              ? await runtime.answerText(conversation, settled.answer)
              : "";
          return send(res, 200, {
            submissionId: submission.id as unknown as number,
            status: settled.status,
            reason: settled.reason ?? null,
            answer,
          });
        }
        return send(res, 200, { submissionId: submission.id as unknown as number });
      }

      if (req.method === "POST" && path === "/api/abort") {
        const body = await readJson(req);
        const conversation = await resolveConversation(conversationIdOf(body));
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        await conversation.abort(context);
        return send(res, 200, { ok: true });
      }

      if (req.method === "POST" && path === "/api/reset") {
        const body = await readJson(req);
        const conversation = await resolveConversation(conversationIdOf(body));
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        await conversation.reset(typeof body["handoff"] === "string" ? (body["handoff"] as string) : undefined, context);
        return send(res, 200, { ok: true });
      }

      if (req.method === "GET" && path === "/api/memory") {
        const [global, work] = await Promise.all([
          runtime.harness.snapshot(GlobalMemory, context),
          runtime.harness.snapshot(WorkMemory, context),
        ]);
        const id = Number(url.searchParams.get("chat"));
        const chat =
          Number.isFinite(id) && id > 0
            ? await runtime.harness.snapshot(ChatMemory, id as never, context)
            : undefined;
        return send(res, 200, {
          global: global?.notes ?? [],
          work: work?.notes ?? [],
          chat: chat?.notes ?? [],
        });
      }

      if (req.method === "GET" && path === "/api/changes") {
        const conversationId = Number(url.searchParams.get("conversationId"));
        const dir = await dirFor(Number.isFinite(conversationId) ? conversationId : undefined);
        const snapshot = await collectChanges(dir);
        const branch = await execGit(dir, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
        return send(res, 200, { ...snapshot, workspace: dir, branch: branch.trim() });
      }

      if (req.method === "POST" && path === "/api/commit") {
        const body = await readJson(req);
        const message = typeof body["message"] === "string" && body["message"].trim().length > 0
          ? (body["message"] as string)
          : "workspace: checkpoint";
        const dir = await dirFor(conversationIdOf(body));
        await ensureRepo(dir);
        const head = await commitChanges(dir, message);
        return send(res, 200, { head });
      }


      if (req.method === "GET" && path === "/api/file") {
        const root = await dirFor(Number(url.searchParams.get("conversationId")));
        const requested = url.searchParams.get("path") ?? "";
        const absolute = isAbsolute(requested) ? requested : resolve(root, requested);
        const rel = relative(root, absolute);
        // The client may only read inside the workspace it belongs to.
        if (rel.startsWith("..") || isAbsolute(rel)) return send(res, 400, { error: "path outside workspace" });
        const info = await stat(absolute).catch(() => undefined);
        if (info === undefined || !info.isFile()) return send(res, 404, { error: "not a file" });
        const MAX = 512 * 1024;
        const raw = await readFile(absolute);
        const truncated = raw.byteLength > MAX;
        const content = raw.subarray(0, MAX).toString("utf8");
        return send(res, 200, {
          path: rel,
          size: info.size,
          truncated,
          lines: content.split("\n").length,
          content,
        });
      }

      if (req.method === "GET" && path === "/api/search") {
        const query = (url.searchParams.get("q") ?? "").trim();
        if (query.length < 2) return send(res, 200, { hits: [] });
        const needle = query.toLowerCase();
        const chats = (await runtime.harness.snapshot(ChatsToken, context).catch(() => undefined)) as
          | { chats: Record<string, number> }
          | undefined;
        const ids = Object.values(chats?.chats ?? {}).slice(0, 60);
        const hits: Array<{ conversationId: number; entryId: number; kind: string; snippet: string }> = [];
        for (const id of ids) {
          if (hits.length >= 30) break;
          const conversation = await resolveConversation(id);
          if (conversation === undefined) continue;
          const page = await conversation
            .entries({ order: "descending" }, 300, undefined, context)
            .catch(() => undefined);
          if (page === undefined) continue;
          for (const entry of page.items) {
            // Search the readable text, not the raw JSON: a snippet of escaped
            // tool payloads is useless in a result list.
            const text = entryText(entry.model);
            const at = text.toLowerCase().indexOf(needle);
            if (at === -1) continue;
            hits.push({
              conversationId: id,
              entryId: entry.id as unknown as number,
              kind: entry.kind,
              snippet: text.slice(Math.max(0, at - 60), at + 120).replace(/\s+/g, " ").trim(),
            });
            if (hits.length >= 30) break;
          }
        }
        return send(res, 200, { hits });
      }

      if (req.method === "POST" && path === "/api/merge") {
        const body = await readJson(req);
        const conversationId = conversationIdOf(body);
        if (conversationId === undefined) return send(res, 400, { error: "conversationId required" });
        const result = await mergeWorktree(
          await runtime.projectPathOf(conversationId),
          conversationId,
          await runtime.baseBranchOf(conversationId),
        );
        log("http", "merge requested", { conversationId, status: result.status });
        return send(res, 200, result);
      }

      if (req.method === "POST" && path === "/api/memory/curate") {
        const body = await readJson(req);
        const hours = Number(body["hours"] ?? 24);
        const result = await runtime.curateMemory(Number.isFinite(hours) ? hours : 24);
        return send(res, 200, result);
      }

      if (req.method === "POST" && path === "/api/memory/apply") {
        const body = await readJson(req);
        const accepted = Array.isArray(body["suggestions"])
          ? (body["suggestions"] as import("./curator.ts").Suggestion[])
          : [];
        const result = await runtime.applyMemorySuggestions(accepted);
        return send(res, 200, result);
      }

      if (req.method === "GET" && path === "/api/approvals") {
        return send(res, 200, { approvals: listApprovals() });
      }

      if (req.method === "POST" && path === "/api/approvals") {
        const body = await readJson(req);
        const callId = typeof body["callId"] === "string" ? body["callId"] : "";
        const approved = body["approved"] === true;
        if (callId.length === 0) return send(res, 400, { error: "callId required" });
        // "Allow for the rest of this conversation": worth doing before the resolve, so a
        // run that resumes immediately already sees the grant.
        const pending = listApprovals().find((entry) => entry.callId === callId);
        if (approved && body["session"] === true && pending?.grantKey !== undefined) {
          const conversationId = Number(body["conversationId"] ?? pending.conversationId ?? 0);
          if (conversationId > 0) await runtime.grantSession(conversationId, pending.grantKey);
        }
        const handled = resolveApproval(callId, approved, "client");
        return send(res, handled ? 200 : 404, { ok: handled });
      }

      if (req.method === "GET" && path === "/api/git") {
        const conversationId = Number(url.searchParams.get("conversationId"));
        if (!Number.isFinite(conversationId)) return send(res, 400, { error: "conversationId required" });
        const worktree = await dirFor(conversationId);
        const projectPath = await runtime.projectPathOf(conversationId);
        const base = await runtime.baseBranchOf(conversationId);
        const [commits, branchList, remote] = await Promise.all([
          commitLog(worktree, projectPath, Math.min(Number(url.searchParams.get("limit") ?? 20) || 20, 100), base),
          branches(projectPath),
          remoteInfo(projectPath),
        ]);
        const head = await execGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "");
        return send(res, 200, {
          worktree,
          branch: head.trim(),
          base,
          origin: await runtime.originBranchOf(conversationId).catch(() => undefined),
          commits,
          branches: branchList,
          remote,
          compareUrl: compareUrl(remote, base.trim(), head.trim()),
        });
      }

      if (req.method === "POST" && path === "/api/git/base") {
        const body = await readJson(req);
        const conversationId = conversationIdOf(body);
        const branch = typeof body["base"] === "string" ? (body["base"] as string).trim() : "";
        if (conversationId === undefined || branch.length === 0) {
          return send(res, 400, { error: "conversationId and base required" });
        }
        await runtime.setBaseBranch(conversationId, branch);
        return send(res, 200, { ok: true, base: branch });
      }

      if (req.method === "GET" && path === "/api/git/diff") {
        const conversationId = Number(url.searchParams.get("conversationId"));
        const hash = url.searchParams.get("hash") ?? "";
        if (!Number.isFinite(conversationId) || !/^[0-9a-f]{6,40}$/i.test(hash)) {
          return send(res, 400, { error: "conversationId and hash required" });
        }
        const diff = await commitDiff(await dirFor(conversationId), hash);
        return send(res, 200, { hash, diff });
      }

      if (req.method === "POST" && path === "/api/git/push") {
        const body = await readJson(req);
        const conversationId = conversationIdOf(body);
        if (conversationId === undefined) return send(res, 400, { error: "conversationId required" });
        const worktree = await dirFor(conversationId);
        const projectPath = await runtime.projectPathOf(conversationId);
        const branch =
          (await execGit(worktree, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")).trim() ||
          worktreePaths(projectPath, conversationId).branch;
        const result = await pushBranch(worktree, projectPath, branch, {
          dryRun: body["dryRun"] === true,
          base: await runtime.baseBranchOf(conversationId),
        });
        return send(res, 200, result);
      }

      if (req.method === "GET" && path === "/api/tasks") {
        const inspection = await runtime.harness.inspect(context);
        return send(res, 200, {
          tasks: inspection.tasks.map((task) => ({
            id: task.record.id,
            kind: task.record.kind,
            conversationId: task.record.conversationId,
            owner: task.record.owner ?? null,
            state: (task.state as unknown as { kind?: string }).kind ?? "?",
            until: (task.state as unknown as { until?: number }).until,
            title: taskTitle(task.record.kind, task.record.input),
          })),
        });
      }

      return send(res, 404, { error: "not found" });
    } catch (error) {
      logError("http", `${req.method} ${req.url} failed`, error);
      return send(res, 500, { error: (error as Error).message });
    }
  });

  const wss = new WebSocketServer({ noServer: true });
  const watches = new Map<WebSocket, () => Promise<void>>();

  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname !== "/ws") return socket.destroy();
      if (!tokenMatches(bearer(req) || url.searchParams.get("token") || "")) return socket.destroy();
      const id = Number(url.searchParams.get("conversationId"));
      const conversation = await resolveConversation(Number.isFinite(id) ? id : undefined);
      if (conversation === undefined) return socket.destroy();

      wss.handleUpgrade(req, socket, head, (ws) => {
        void attach(ws, conversation);
      });
    } catch (error) {
      logError("ws", "upgrade failed", error);
      socket.destroy();
    }
  });

  async function attach(ws: WebSocket, conversation: Conversation): Promise<void> {
    // One watch per socket: first frame is the current view, then every commit.
    const watch = await conversation.watch(context);
    const push = (value: unknown, ops?: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: "value", value, ops: ops ?? [] }));
    };
    push(watch.value);

    watch.start(async (call) => {
      if (call.kind !== "value") return;
      push(call.value, call.ops);
    });

    const stop = async () => {
      watches.delete(ws);
      await watch.stop().catch(() => {});
    };
    watches.set(ws, stop);
    ws.on("close", () => void stop());
    ws.on("error", () => void stop());
    log("http", "client attached", { conversationId: conversation.id as unknown as number });
  }

  await new Promise<void>((resolve) => server.listen(port, host, resolve));
  const address = server.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  log("http", `client bridge listening`, { url: `http://${host}:${boundPort}`, auth: config.http.token.length > 0 });

  return {
    port: boundPort,
    close: async () => {
      for (const stop of watches.values()) await stop();
      wss.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
