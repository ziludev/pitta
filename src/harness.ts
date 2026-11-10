import { mkdir } from "node:fs/promises";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ConversationBusy,
  defineDoc,
  defineExtension,
  Harness,
  createRegistry,
  type Conversation,
  type EntryId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertModelAvailable, createAgentModels, warnIfRoutingGroup } from "./models.ts";
import { ChatMemory, GlobalMemory, memoryExtension, type Note } from "./memory.ts";
import type { ToolStep } from "./details.ts";
import { reminderExtension } from "./reminders.ts";
import { guardExtension } from "./approval.ts";
import { larkExtension } from "./lark-tools.ts";
import { skillsExtension } from "./skills.ts";
import { subagentExtension } from "./subagents.ts";
import { UsageSampler, UsageDays, sampleUsage, usageCalendar } from "./usage-days.ts";
import { applySuggestions, curateMemory } from "./curator.ts";
import { connectMcp, type McpRuntime } from "./mcp.ts";
import { personalExtension } from "./personal.ts";
import { checkBudget, type BudgetCheck } from "./budget.ts";
import { rememberSurface } from "./channel.ts";
import { log } from "./log.ts";
import { acquireStorageLock } from "./storage-lock.ts";
import { ensureRepo } from "./changes.ts";
import { ensureWorktree, worktreePaths } from "./worktree.ts";
import { setHarnessRef } from "./runtime-ref.ts";
import { forkAt, lookupMessage, lookupThread, recordMessage, recordThread } from "./threads.ts";
import { config } from "./config.ts";

export const context = BACKGROUND_CONTEXT;

/** chat surface id (Feishu chat_id, "cli", ...) -> conversation id. Session-scoped, so it survives restarts. */
/** Host default model, so "设为默认" survives restarts without editing .env. */
export const DefaultModel = defineDoc<{ provider: string; modelId: string; thinkingLevel?: string }>({
  kind: "app.default-model",
  version: 1,
  scope: "session",
  initial: () => ({ provider: "", modelId: "" }),
  checkpointWhen: () => false,
});

export const ChatsToken = defineDoc<{ chats: Record<string, number> }>({
  kind: "app.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: () => false,
});

export type AgentRuntime = {
  harness: Harness;
  conversationFor(surfaceId: string): Promise<Conversation>;
  /** Maps a conversation back to its surface, so approvals and reminders can route. */
  attachSurface(conversationId: number): Promise<void>;
  /** Creates a fresh conversation for a surface (client "new chat"). */
  newConversation(surfaceId: string): Promise<Conversation>;
  /** The surface a conversation belongs to, for rename/archive/cleanup by chat id. */
  surfaceOf(conversationId: number): Promise<string | undefined>;
  /** Reply/thread conversation: forked at the answered message, or the chat itself. */
  conversationForThread(
    surfaceId: string,
    options: { threadKey?: string; parentMessageId?: string },
  ): Promise<Conversation>;
  recordMessage(messageId: string, conversation: Conversation, entryId: number): Promise<void>;
  answerText(conversation: Conversation, answerId: EntryId): Promise<string>;
  /** Tool calls of one run, in order, with short output previews. */
  turnSteps(conversation: Conversation, from: number, to: number): Promise<ToolStep[]>;
  budget(surfaceId: string): Promise<BudgetCheck>;
  models: () => Array<{
    provider: string;
    providerName: string;
    id: string;
    name: string;
    reasoning: boolean;
    contextWindow: number;
    maxTokens: number;
    cost: { input: number; output: number };
    thinkingLevels: string[];
  }>;
  defaultModel(): Promise<{ provider: string; modelId: string; thinkingLevel?: string } | undefined>;
  setDefaultModel(input: { provider: string; modelId: string; thinkingLevel?: string }): Promise<void>;
  setModel(
    conversation: Conversation,
    model: { provider: string; modelId: string; thinkingLevel?: string },
  ): Promise<void>;
  usageCalendar(days: number): Promise<Array<{ date: string; cost: number; tokens: number }>>;
  curateMemory(hours?: number): Promise<import("./curator.ts").CurateResult>;
  applyMemorySuggestions(
    accepted: import("./curator.ts").Suggestion[],
  ): Promise<{ added: number; skipped: number }>;
  mcp: McpRuntime;
  memories(conversation: Conversation): Promise<{ global: Note[]; chat: Note[] }>;
  close(): Promise<void>;
};

export async function openRuntime(options: { workspace?: string } = {}): Promise<AgentRuntime> {
  const workspace = options.workspace ?? config.workspace;
  await mkdir(workspace, { recursive: true });
  // A repo in the workspace makes every edit reviewable and revertible from the client.
  if ((process.env.AGENT_WORKSPACE_GIT ?? "auto") !== "off") await ensureRepo(workspace);
  await mkdir(dirname(config.dbPath), { recursive: true });

  // Fail loudly instead of corrupting a running session.
  acquireStorageLock(config.dbPath);

  const models = createAgentModels();
  assertModelAvailable(models);
  warnIfRoutingGroup();

  const mcp = await connectMcp(
    config.mcpConfig.startsWith("/") ? config.mcpConfig : `${process.cwd()}/${config.mcpConfig}`,
    workspace,
  );

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(personalExtension);
  registry.install(larkExtension);
  registry.install(skillsExtension);
  registry.install(memoryExtension);
  registry.install(reminderExtension);
  registry.install(guardExtension);
  registry.install(subagentExtension);
  registry.install(defineExtension({ name: "usage-sampler", tasks: [UsageSampler] }));
  if (mcp.extension !== undefined) registry.install(mcp.extension);

  const harness = await Harness.open(
    await openNodeSqliteStorage(config.dbPath),
    {
      models,
      registry,
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? workspace }),
      settings: {
        retry: { maxRetries: 3 },
        compaction: { reserveTokens: 16384 },
        toolExecution: "parallel",
      },
      onReport: (report) => {
        // Hook/tool/listener failures never throw into the harness, so log them here.
        console.error(`[report] ${report.kind}`, JSON.stringify(report).slice(0, 800));
      },
    },
    context,
  );
  harness.resume();
  setHarnessRef(harness);

  // Keep one sampler alive: it turns cumulative usage into per-day history.
  const root = await harness.root(context);
  const inspection = await harness.inspect(context);
  if (!inspection.tasks.some((task) => task.record.kind === "app.usage-sampler")) {
    await root.commit(async (tx) => {
      await tx.createTask(UsageSampler, null, { ownership: { kind: "conversation" }, background: true });
      return undefined;
    }, context);
    log("usage", "sampler started");
  }

  const storedDefault = await harness.snapshot(DefaultModel, context).catch(() => undefined);
  const agentChange = {
    model: {
      provider: storedDefault?.provider ?? config.model.provider,
      modelId: storedDefault?.modelId ?? config.model.modelId,
    },
    thinkingLevel: (storedDefault?.thinkingLevel ?? config.thinkingLevel) as typeof config.thinkingLevel,
    cwd: workspace,
    maxTurns: config.maxTurns,
  } as const;

  async function conversationFor(surfaceId: string): Promise<Conversation> {
    const mapping = await harness.snapshot(ChatsToken, context);
    const known = mapping?.chats[surfaceId];
    if (known !== undefined) {
      const existing = await harness.conversation(
        known as unknown as Parameters<typeof harness.conversation>[0],
        context,
      );
      if (existing !== undefined) {
        rememberSurface(existing.id as unknown as number, surfaceId);
        return existing;
      }
    }
    const created = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: agentChange },
      context,
    );

    // Each conversation works in its own worktree so parallel sessions never fight
    // over the same files. The id only exists after creation, so cwd follows in a
    // second commit; without git this stays the shared workspace.
    if (config.worktree !== "off") {
      const worktree = await ensureWorktree(workspace, created.id as unknown as number);
      if (worktree !== undefined) await created.configure({ cwd: worktree.dir }, context);
    }
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ChatsToken);
      doc.chats[surfaceId] = created.id as unknown as number;
    }, context);
    rememberSurface(created.id as unknown as number, surfaceId);
    console.log(`[agent] new conversation ${created.id} for surface ${surfaceId}`);
    return created;
  }

  async function newConversation(surfaceId: string): Promise<Conversation> {
    const created = await harness.createConversation(
      { ownership: { kind: "ownerless" }, agent: agentChange },
      context,
    );
    if (config.worktree !== "off") {
      const worktree = await ensureWorktree(workspace, created.id as unknown as number);
      if (worktree !== undefined) await created.configure({ cwd: worktree.dir }, context);
    }
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ChatsToken);
      doc.chats[surfaceId] = created.id as unknown as number;
    }, context);
    rememberSurface(created.id as unknown as number, surfaceId);
    log("agent", "new conversation", { surfaceId, conversationId: created.id as unknown as number });
    return created;
  }

  async function surfaceOf(conversationId: number): Promise<string | undefined> {
    const mapping = await harness.snapshot(ChatsToken, context).catch(() => undefined);
    for (const [surfaceId, id] of Object.entries(mapping?.chats ?? {})) {
      if ((id as unknown as number) === conversationId) return surfaceId;
    }
    return undefined;
  }

  async function attachSurface(conversationId: number): Promise<void> {
    const mapping = await harness.snapshot(ChatsToken, context).catch(() => undefined);
    for (const [surfaceId, id] of Object.entries(mapping?.chats ?? {})) {
      if ((id as unknown as number) === conversationId) rememberSurface(conversationId, surfaceId);
    }
  }

  async function conversationForThread(
    surfaceId: string,
    options: { threadKey?: string; parentMessageId?: string },
  ): Promise<Conversation> {
    const threadKey = options.threadKey ?? options.parentMessageId;
    if (threadKey !== undefined) {
      const known = await lookupThread(harness, context, threadKey);
      if (known !== undefined) {
        const existing = await harness.conversation(
          known as unknown as Parameters<typeof harness.conversation>[0],
          context,
        );
        if (existing !== undefined) {
          rememberSurface(existing.id as unknown as number, surfaceId);
          return existing;
        }
      }
      // First message of this thread: fork the chat conversation where it branched off.
      const anchor =
        options.parentMessageId === undefined
          ? undefined
          : await lookupMessage(harness, context, options.parentMessageId);
      if (anchor !== undefined) {
        const parent = await harness.conversation(
          anchor.conversationId as unknown as Parameters<typeof harness.conversation>[0],
          context,
        );
        if (parent !== undefined) {
          // Empty change: the fork inherits the parent's agent at the fork entry,
          // which keeps it in the same worktree as the chat it branched from.
          const forked = await forkAt(parent, anchor.entryId, {}, context);
          await recordThread(harness, context, threadKey, forked.id as unknown as number);
          rememberSurface(forked.id as unknown as number, surfaceId);
          console.log(`[agent] forked conversation ${forked.id} from ${parent.id} at entry ${anchor.entryId}`);
          return forked;
        }
      }
    }
    return conversationFor(surfaceId);
  }

  async function recordMessageFor(
    messageId: string,
    conversation: Conversation,
    entryId: number,
  ): Promise<void> {
    await recordMessage(harness, context, messageId, conversation.id as unknown as number, entryId);
  }

  async function turnSteps(conversation: Conversation, from: number, to: number): Promise<ToolStep[]> {
    const page = await conversation.entries(
      { minEntryId: from as unknown as EntryId, maxEntryId: to as unknown as EntryId, order: "ascending" },
      200,
      undefined,
      context,
    );
    const calls = new Map<string, string>();
    const steps: ToolStep[] = [];
    for (const entry of page.items) {
      const messages = (entry.model ?? []) as unknown as Array<Record<string, unknown>>;
      for (const message of messages) {
        const role = message["role"];
        const content = message["content"];
        if (role === "assistant" && Array.isArray(content)) {
          for (const part of content as Array<Record<string, unknown>>) {
            if (part["type"] === "toolCall" && typeof part["id"] === "string" && typeof part["name"] === "string") {
              calls.set(part["id"], part["name"]);
            }
          }
        } else if (role === "toolResult") {
          // A tool result is a message of its own: { role: "toolResult", toolName, content }.
          const callId = typeof message["toolCallId"] === "string" ? message["toolCallId"] : "";
          const body = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
          const text = body
            .filter((item) => item["type"] === "text" && typeof item["text"] === "string")
            .map((item) => String(item["text"]))
            .join("")
            .replace(/\s+/g, " ")
            .trim();
          steps.push({
            name: typeof message["toolName"] === "string" ? message["toolName"] : calls.get(callId) ?? "tool",
            ok: message["isError"] !== true,
            preview: text.slice(0, 240),
          });
        }
      }
    }
    return steps;
  }

  async function answerText(conversation: Conversation, answerId: EntryId): Promise<string> {
    const entry = await conversation.commit((tx) => tx.entry(AssistantEntry, answerId), context);
    const messages = (entry?.model ?? []) as unknown as Array<{ content?: unknown }>;
    const parts: string[] = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content as Array<Record<string, unknown>>) {
        if (part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
      }
    }
    return parts.join("").trim();
  }

  log("agent", `mcp: ${mcp.serverCount} servers, ${mcp.toolCount} tools`);

  return {
    harness,
    conversationFor,
    attachSurface,
    newConversation,
    surfaceOf,
    conversationForThread,
    recordMessage: recordMessageFor,
    turnSteps,
    answerText,
    memories: async (conversation) => ({
      global: (await harness.snapshot(GlobalMemory, context))?.notes ?? [],
      chat: (await harness.snapshot(ChatMemory, conversation.id, context))?.notes ?? [],
    }),
    models: () =>
      models.getProviders().flatMap((provider) =>
        models
          .getModels(provider.id)
          .slice(0, 40)
          .map((model) => ({
            provider: provider.id,
            providerName: provider.name ?? provider.id,
            id: model.id,
            name: model.name ?? model.id,
            reasoning: model.reasoning === true,
            contextWindow: model.contextWindow ?? 0,
            maxTokens: model.maxTokens ?? 0,
            cost: { input: model.cost?.input ?? 0, output: model.cost?.output ?? 0 },
            thinkingLevels: getSupportedThinkingLevels(model) as unknown as string[],
          })),
      ),

    defaultModel: async () => {
      const stored = await harness.snapshot(DefaultModel, context);
      if (stored === undefined) return undefined;
      return { provider: stored.provider, modelId: stored.modelId, thinkingLevel: stored.thinkingLevel };
    },

    setDefaultModel: async (input) => {
      await harness.commit(async (tx) => {
        const doc = await tx.doc(DefaultModel);
        doc.provider = input.provider;
        doc.modelId = input.modelId;
        if (input.thinkingLevel !== undefined) doc.thinkingLevel = input.thinkingLevel;
      }, context);
      log("agent", "default model updated", input);
    },
    setModel: (conversation, model) =>
      conversation.configure(
        {
          model: { provider: model.provider, modelId: model.modelId },
          ...(model.thinkingLevel === undefined ? {} : { thinkingLevel: model.thinkingLevel as never }),
        },
        context,
      ),
    curateMemory: (hours) => curateMemory(harness, models, context, { hours }),
    applyMemorySuggestions: (accepted) => applySuggestions(harness, context, accepted),
    usageCalendar: async (days) => {
      // Sample first: the background sampler only runs every 10 minutes.
      await sampleUsage(harness, context).catch(() => {});
      return usageCalendar(
        (ctx) => harness.snapshot(UsageDays, ctx) as Promise<
          | {
              days: Record<string, never>;
              baseline?: { cost: number; tokens: number; input: number; output: number };
            }
          | undefined
        >,
        context,
        days,
      );
    },
    // Budget is session-wide: one owner, one daily allowance.
    budget: (_surfaceId: string) => checkBudget(harness, context, config.dailyBudgetUsd),
    close: async () => {
      await harness.close(context);
      await mcp.close();
    },
    mcp: mcp as McpRuntime,
  };
}

export { ConversationBusy };
