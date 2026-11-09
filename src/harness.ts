import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  AssistantEntry,
  ConversationBusy,
  defineDoc,
  Harness,
  createRegistry,
  type Conversation,
  type EntryId,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { assertModelAvailable, createAgentModels } from "./models.ts";
import { ChatMemory, GlobalMemory, memoryExtension, type Note } from "./memory.ts";
import { reminderExtension } from "./reminders.ts";
import { guardExtension } from "./approval.ts";
import { personalExtension } from "./personal.ts";
import { checkBudget, type BudgetCheck } from "./budget.ts";
import { rememberSurface } from "./channel.ts";
import { config } from "./config.ts";

export const context = BACKGROUND_CONTEXT;

/** chat surface id (Feishu chat_id, "cli", ...) -> conversation id. Session-scoped, so it survives restarts. */
const Chats = defineDoc<{ chats: Record<string, number> }>({
  kind: "app.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: () => false,
});

export type AgentRuntime = {
  harness: Harness;
  conversationFor(surfaceId: string): Promise<Conversation>;
  answerText(conversation: Conversation, answerId: EntryId): Promise<string>;
  budget(surfaceId: string): Promise<BudgetCheck>;
  memories(conversation: Conversation): Promise<{ global: Note[]; chat: Note[] }>;
  close(): Promise<void>;
};

export async function openRuntime(options: { workspace?: string } = {}): Promise<AgentRuntime> {
  const workspace = options.workspace ?? config.workspace;
  await mkdir(workspace, { recursive: true });
  await mkdir(dirname(config.dbPath), { recursive: true });

  const models = createAgentModels();
  assertModelAvailable(models);

  const registry = createRegistry();
  registry.install(CodingTools);
  registry.install(personalExtension);
  registry.install(memoryExtension);
  registry.install(reminderExtension);
  registry.install(guardExtension);

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

  const agentChange = {
    model: { provider: config.model.provider, modelId: config.model.modelId },
    thinkingLevel: config.thinkingLevel,
    cwd: workspace,
    maxTurns: config.maxTurns,
  } as const;

  async function conversationFor(surfaceId: string): Promise<Conversation> {
    const mapping = await harness.snapshot(Chats, context);
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
    await harness.commit(async (tx) => {
      const doc = await tx.doc(Chats);
      doc.chats[surfaceId] = created.id as unknown as number;
    }, context);
    rememberSurface(created.id as unknown as number, surfaceId);
    console.log(`[agent] new conversation ${created.id} for surface ${surfaceId}`);
    return created;
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

  return {
    harness,
    conversationFor,
    answerText,
    memories: async (conversation) => ({
      global: (await harness.snapshot(GlobalMemory, context))?.notes ?? [],
      chat: (await harness.snapshot(ChatMemory, conversation.id, context))?.notes ?? [],
    }),
    // Budget is session-wide: one owner, one daily allowance.
    budget: (_surfaceId: string) => checkBudget(harness, context, config.dailyBudgetUsd),
    close: () => harness.close(context),
  };
}

export { ConversationBusy };
