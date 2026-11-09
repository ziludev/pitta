import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import type { Conversation } from "@earendil-works/pi-durable";
import { ChatsToken, context, type AgentRuntime } from "./harness.ts";
import { ChatMemory, GlobalMemory, WorkMemory } from "./memory.ts";
import { log, logError } from "./log.ts";
import { config } from "./config.ts";
import { collectChanges, commitChanges, ensureRepo } from "./changes.ts";

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
    return runtime.harness.conversation(id as never, context);
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "OPTIONS") return send(res, 204, {});
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
      const path = url.pathname;

      if (!tokenMatches(bearer(req))) return send(res, 401, { error: "unauthorized" });

      if (req.method === "GET" && path === "/api/state") {
        const [inspection, usage] = await Promise.all([
          runtime.harness.inspect(context),
          runtime.harness.usage(context),
        ]);
        const chats = (await runtime.harness.snapshot(ChatsToken, context).catch(() => undefined)) as
          | { chats: Record<string, number> }
          | undefined;
        const surfaces = Object.entries(chats?.chats ?? {}).map(([surfaceId, conversationId]) => ({
          surfaceId,
          conversationId,
        }));
        return send(res, 200, {
          surfaces,
          tasks: inspection.tasks.map((task) => ({
            id: task.record.id,
            kind: task.record.kind,
            conversationId: task.record.conversationId,
            background: task.record.background === true,
            state: (task.state as unknown as { kind?: string }).kind ?? "?",
          })),
          usage,
        });
      }

      if (req.method === "GET" && path === "/api/conversation") {
        const id = Number(url.searchParams.get("id"));
        const conversation = await resolveConversation(Number.isFinite(id) ? id : undefined);
        if (conversation === undefined) return send(res, 404, { error: "no such conversation" });
        const page = await conversation.entries(
          { order: "ascending" },
          Math.min(Number(url.searchParams.get("limit") ?? 100) || 100, 500),
          undefined,
          context,
        );
        return send(res, 200, {
          conversationId: conversation.id as unknown as number,
          entries: page.items.map((entry) => ({
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
        if (text.trim().length === 0) return send(res, 400, { error: "empty text" });
        const mode = body["mode"];
        const whenBusy = mode === "steer" ? "steer" : mode === "reject" ? "reject" : "followUp";
        const submission = await conversation.submit({ type: "input", content: text, whenBusy }, context);
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
        const snapshot = await collectChanges(config.workspace);
        return send(res, 200, { ...snapshot, workspace: config.workspace });
      }

      if (req.method === "POST" && path === "/api/commit") {
        const body = await readJson(req);
        const message = typeof body["message"] === "string" && body["message"].trim().length > 0
          ? (body["message"] as string)
          : "workspace: checkpoint";
        await ensureRepo(config.workspace);
        const head = await commitChanges(config.workspace, message);
        return send(res, 200, { head });
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
