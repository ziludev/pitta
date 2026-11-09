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

const MAX_SECTION_NOTES = 40;

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
    await api.commit(async (tx) => {
      const doc =
        scope === "global" ? await tx.doc(GlobalMemory) : await tx.doc(ChatMemory, api.conversationId);
      doc.notes.push({ at, text: args.text });
      total = doc.notes.length;
    }, context);
    return {
      output: [
        { type: "text" as const, text: `已记住（${scope}，共 ${total} 条）：${args.text}` },
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

function renderNotes(notes: Note[] | undefined): string | undefined {
  if (notes === undefined || notes.length === 0) return undefined;
  return notes
    .slice(-MAX_SECTION_NOTES)
    .map((note) => `- ${note.at.slice(0, 10)} ${note.text}`)
    .join("\n");
}

/** Memory sections + tools, ready for the personal extension. */
export const memorySections = [
  section("global_memory", async (input, context) => {
    const doc = await input.read.snapshot(GlobalMemory, context);
    return renderNotes(doc?.notes);
  }),
  section("chat_memory", async (input, context) => {
    const doc = await input.read.snapshot(ChatMemory, input.conversationId, context);
    return renderNotes(doc?.notes);
  }),
];

export const memoryTools = [remember, forget];

export const memoryExtension = defineExtension({
  name: "memory",
  sections: memorySections,
  tools: memoryTools,
});
