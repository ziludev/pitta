import {
  defineDoc,
  defineExtension,
  defineTask,
  hook,
  GenerationTask,
  runEndTask,
  type HookApi,
  type RunningTask,
  type RunSummary,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { SurfaceMetaDoc, type SurfaceMeta } from "./surface-meta.ts";
import { config } from "./config.ts";
import { log } from "./log.ts";

/**
 * A title for a conversation, written once, after its first answer.
 *
 * The rail shows the first 32 characters of the first message, which reads like a fragment
 * ("用一句话介绍你自己，并说出你当…"). A short title the model writes from the actual question is
 * cheaper to scan, and this is the shape `runEndTask` exists for: a durable task asked for by an
 * `afterRun` hook, so a crash before it is created asks again and a created one is never repeated.
 */

/** The surface <-> conversation map; the same session doc the harness keeps. */
const ChatsDoc = defineDoc<{ chats: Record<string, number> }>({
  kind: "app.chats",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: () => false,
});

const TITLE_PROMPT =
  "给这条对话起一个标题：不超过 14 个字，名词短语，说清在聊什么；不要引号、句号、emoji，" +
  "不要以「用户」「询问」开头。只输出标题本身。";

type TitleInput = { conversationId: number; surfaceId: string };

export function cleanTitle(raw: string): string {
  return raw
    .replace(/^[#\s"'“”「」]+|[#\s"'“”「」。.!！]+$/g, "")
    .split("\n")[0]
    ?.slice(0, 24)
    .trim() ?? "";
}

export const TitleTask = defineTask<TitleInput, { phase: "run" }, string>({
  name: "app.title",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task: RunningTask<TitleInput, { phase: "run" }, string>, runtime, context: Context) => {
      const done = async (result: string) =>
        runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result } }), context);
      const model = runtime.models.getModel(config.model.provider, config.model.modelId);
      if (model === undefined) return done("no-model");

      const page = await runtime.entries({ order: "ascending" }, 6, undefined, context);
      const question = page.items
        .flatMap((entry) => entry.model ?? [])
        .filter((message) => message.role === "user" && typeof message.content === "string")
        .map((message) => String(message.content))
        .find((text) => text.trim().length > 0);
      if (question === undefined) return done("no-question");

      const answer = await runtime.models.complete(model, {
        systemPrompt: TITLE_PROMPT,
        messages: [{ role: "user", content: question.slice(0, 600), timestamp: Date.now() }],
      });
      const title = cleanTitle(
        (answer.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
      );
      if (title.length === 0) return done("empty");

      await runtime.commit(async (tx) => {
        const doc = await tx.doc(SurfaceMetaDoc);
        const meta = doc.surfaces[task.input.surfaceId] as SurfaceMeta | undefined;
        // The owner may have renamed it while this ran: theirs wins.
        if (meta?.title === undefined || meta.title.length === 0) {
          doc.surfaces[task.input.surfaceId] = {
            ...(meta ?? { createdAt: Date.now() }),
            title,
          };
        }
        return { status: "terminal", outcome: { status: "completed", result: title } };
      }, context);
      log("title", "named a conversation", { surfaceId: task.input.surfaceId.slice(-6), title });
    },
  },
  abort: (_task, runtime, context) => runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/** Asked once, after the first answer of a conversation that still has no title. */
async function afterRun(run: RunSummary, api: HookApi, context: Context) {
  if (run.reason !== "answer") return undefined;
  const conversationId = api.conversationId as unknown as number;
  const recent = await api.entries({ order: "descending" }, 3, undefined, context).catch(() => undefined);
  if (recent === undefined || recent.items.filter((entry) => entry.kind === "pi.assistant").length > 1) {
    return undefined;
  }
  const mapping = await api.snapshot(ChatsDoc, context).catch(() => undefined);
  const surfaceId = Object.entries(mapping?.chats ?? {}).find(([, id]) => id === conversationId)?.[0];
  if (surfaceId === undefined) return undefined;
  const meta = (await api.snapshot(SurfaceMetaDoc, context).catch(() => undefined))?.surfaces[surfaceId];
  if (meta?.title !== undefined && meta.title.length > 0) return undefined;
  return { tasks: [runEndTask(TitleTask, { conversationId, surfaceId } satisfies TitleInput)] };
}

export const titleExtension = defineExtension({
  name: "title",
  tasks: [TitleTask],
  hooks: [hook(GenerationTask, { afterRun })],
});
