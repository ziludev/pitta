import { defineDoc, defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";

export type Note = { at: string; text: string };

/** Notes that belong to one chat. */
export const ChatMemory = defineDoc<{ notes: Note[] }>({
  kind: "app.memory",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "initial",
  initial: () => ({ notes: [] }),
  checkpointWhen: () => false,
});

/**
 * Notes that follow the owner everywhere. Session scope so every chat shares them:
 * "我偏好先给结论" should not have to be repeated per conversation.
 */
export const GlobalMemory = defineDoc<{ notes: Note[] }>({
  kind: "app.global-memory",
  version: 1,
  scope: "session",
  initial: () => ({ notes: [] }),
  checkpointWhen: () => false,
});

/** Injected every request, so keep it bounded: recent memory only, everything else via `recall`. */
const MAX_GLOBAL_NOTES = 60;
const MAX_CHAT_NOTES = 20;

const remember = defineTool({
  name: "remember",
  description:
    "记住一条值得长期保留的事实（主人的偏好、习惯、重要的人/项目/日期）。一句话一条，不要记流水账和临时信息。默认写进全局记忆，所有对话共享。",
  parameters: obj({
    text: str({ description: "要记住的内容，一句话" }),
    scope: opt(str({ description: "global（默认，跨对话共享）或 chat（只属于当前对话）" })),
  }),
  execute: async (args, api, context) => {
    const at = new Date().toISOString();
    const scope = args.scope === "chat" ? "chat" : "global";
    let total = 0;
    let duplicate = false;
    await api.commit(async (tx) => {
      const doc =
        scope === "global" ? await tx.doc(GlobalMemory) : await tx.doc(ChatMemory, api.conversationId);
      duplicate = doc.notes.some((note) => note.text.trim() === args.text.trim());
      if (!duplicate) doc.notes.push({ at, text: args.text.trim() });
      total = doc.notes.length;
    }, context);
    return {
      output: [
        {
          type: "text" as const,
          text: duplicate
            ? `这条已经在记忆里了（${scope}，共 ${total} 条）`
            : `已记住（${scope}，共 ${total} 条）：${args.text}`,
        },
      ],
    };
  },
});

const forget = defineTool({
  name: "forget",
  description: "删掉一条记忆，按内容关键词匹配。两个范围都会搜。",
  parameters: obj({ keyword: str({ description: "要删除内容里的关键词" }) }),
  execute: async (args, api, context) => {
    const removed: string[] = [];
    await api.commit(async (tx) => {
      const global = await tx.doc(GlobalMemory);
      const chat = await tx.doc(ChatMemory, api.conversationId);
      for (const doc of [global, chat]) {
        const kept = doc.notes.filter((note) => !note.text.includes(args.keyword));
        for (const note of doc.notes) {
          if (note.text.includes(args.keyword)) removed.push(note.text);
        }
        doc.notes.splice(0, doc.notes.length, ...kept);
      }
    }, context);
    return {
      output: [
        {
          type: "text" as const,
          text: removed.length === 0 ? "没有匹配的记忆" : `删除了 ${removed.length} 条：\n- ${removed.join("\n- ")}`,
        },
      ],
    };
  },
});

const recall = defineTool({
  name: "recall",
  description:
    "在长期记忆里搜索：多个关键词用空格分开，全部命中才算。记忆很多、prompt 里只显示最近若干条时用它找旧信息。",
  parameters: obj({ query: str({ description: "关键词，空格分隔" }) }),
  replay: "safe",
  execute: async (args, api, context) => {
    const terms = args.query
      .split(/\s+/)
      .map((term) => term.trim())
      .filter((term) => term.length > 0);
    const global = await api.snapshot(GlobalMemory, context);
    const chat = await api.snapshot(ChatMemory, api.conversationId, context);
    const hits: string[] = [];
    for (const [label, notes] of [
      ["全局", global?.notes ?? []],
      ["本对话", chat?.notes ?? []],
    ] as const) {
      for (const note of notes) {
        if (terms.every((term) => note.text.includes(term))) {
          hits.push(`- [${label}] ${note.at.slice(0, 10)} ${note.text}`);
        }
      }
    }
    return {
      output: [
        {
          type: "text" as const,
          text: hits.length === 0 ? `没有匹配「${args.query}」的记忆` : hits.join("\n"),
        },
      ],
    };
  },
});

function renderNotes(notes: Note[] | undefined, limit: number): string | undefined {
  if (notes === undefined || notes.length === 0) return undefined;
  const hidden = Math.max(0, notes.length - limit);
  const lines = notes
    .slice(-limit)
    .map((note) => `- ${note.at.slice(0, 10)} ${note.text}`);
  if (hidden > 0) lines.unshift(`（还有 ${hidden} 条更早的，用 recall 搜索）`);
  return lines.join("\n");
}

/** Memory sections + tools, ready for the personal extension. */
export const memorySections = [
  section("global_memory", async (input, context) => {
    const doc = await input.read.snapshot(GlobalMemory, context);
    return renderNotes(doc?.notes, MAX_GLOBAL_NOTES);
  }),
  section("chat_memory", async (input, context) => {
    const doc = await input.read.snapshot(ChatMemory, input.conversationId, context);
    return renderNotes(doc?.notes, MAX_CHAT_NOTES);
  }),
];

export const memoryTools = [remember, forget, recall];

export const memoryExtension = defineExtension({
  name: "memory",
  sections: memorySections,
  tools: memoryTools,
});
