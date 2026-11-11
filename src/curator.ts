import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { ChatMemory, GlobalMemory, MemoryTombstones, WorkMemory, type Note } from "./memory.ts";
import { ChatPolicy } from "./access.ts";
import { log, logError } from "./log.ts";
import { isDuplicate } from "./similar.ts";
import { config } from "./config.ts";

export type Suggestion = { text: string; scope: "global" | "work" | "chat"; reason?: string };
export type CurateResult = {
  suggestions: Suggestion[];
  scanned: number;
  tokens: number;
  error?: string;
};

const MAX_CONVERSATIONS = 12;
const MAX_ENTRIES = 60;
const MAX_CHARS_PER_CONVERSATION = 4000;

const PROMPT = `你在整理一个私人助理的长期记忆。输入是最近若干段对话的摘要。

只抽取"会影响以后对话的稳定事实"：
- 主人的偏好、习惯、表达方式、忌讳
- 稳定的环境事实（机器、路径、账号、常用工具与约定）
- 已经拍板的决定、约定、时间点

不要抽取：
- 一次性任务、临时结论、调试过程中的猜测
- 验证码、随机串、一次性的编号
- 已经存在于"现有记忆"中的内容（哪怕换了说法）
- 任何凭据、密钥、密码

输出严格 JSON，不要解释、不要代码块：
{"add":[{"text":"一句话事实","scope":"work","reason":"为什么值得记"}]}

scope 只用 "work"（项目/环境细节，注入时不出现）或 "chat"（只对这一条对话有用）。
没有值得记的就输出 {"add":[]}。最多 8 条，每条不超过 80 字。`;

function textOfEntry(model: unknown): string {
  const messages = Array.isArray(model) ? (model as Array<Record<string, unknown>>) : [];
  const parts: string[] = [];
  for (const message of messages) {
    const role = String(message["role"] ?? "");
    const content = message["content"];
    if (typeof content === "string") parts.push(`${role}: ${content}`);
    else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        if (part["type"] === "text" && typeof part["text"] === "string") parts.push(`${role}: ${part["text"]}`);
        else if (part["type"] === "thinking") continue;
        else if (part["type"] === "toolCall") parts.push(`${role}: [调用 ${String(part["name"] ?? "")}]`);
      }
    }
  }
  return parts.join("\n");
}

/** Recent conversations as plain text, skipping guest chats (no shared memory there). */
async function digests(harness: Harness, context: Context, hours: number) {
  const since = Date.now() - hours * 3600_000;
  const blocks: string[] = [];
  let scanned = 0;

  const conversations = await harness.commit(async (tx) => {
    const page = await tx.scanConversations({}, 200);
    return page.items.map((record) => record.id);
  }, context);

  for (const id of conversations) {
    if (scanned >= MAX_CONVERSATIONS) break;
    const policy = await harness.snapshot(ChatPolicy, id as never, context).catch(() => undefined);
    if (policy?.guest === true) continue;
    const conversation = await harness.conversation(id as never, context);
    if (conversation === undefined) continue;
    const page = await conversation.entries({ order: "descending" }, MAX_ENTRIES, undefined, context).catch(() => undefined);
    if (page === undefined) continue;

    const recent = page.items
      .filter((entry) => {
        const messages = (entry.model ?? []) as unknown as Array<Record<string, unknown>>;
        const at = messages.find((message) => typeof message["timestamp"] === "number");
        return at === undefined || Number(at["timestamp"]) >= since;
      })
      .reverse();
    if (recent.length === 0) continue;

    const text = recent
      .map((entry) => textOfEntry(entry.model))
      .filter((line) => line.length > 0)
      .join("\n")
      .slice(0, MAX_CHARS_PER_CONVERSATION);
    if (text.length < 50) continue;
    scanned += 1;
    blocks.push(`### 对话 ${String(id)}\n${text}`);
  }
  return { text: blocks.join("\n\n"), scanned };
}

function existingNotes(notes: Note[]): string {
  return notes.map((note) => `- ${note.text}`).join("\n");
}

function parseSuggestions(raw: string): Suggestion[] {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end === -1) return [];
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1)) as {
      add?: Array<{ text?: string; scope?: string; reason?: string }>;
    };
    return (parsed.add ?? [])
      .filter((item) => typeof item.text === "string" && item.text.trim().length >= 6)
      .slice(0, 8)
      .map((item) => ({
        text: item.text!.trim().slice(0, 200),
        scope: item.scope === "chat" ? "chat" : "work",
        reason: item.reason,
      }));
  } catch {
    return [];
  }
}

/**
 * One model call over the recent conversations, returning *suggestions* only.
 * Nothing is written here: the owner reviews them in the client first.
 */
export async function curateMemory(
  harness: Harness,
  models: Awaited<ReturnType<typeof import("./models.ts").createAgentModels>>,
  context: Context,
  options: { hours?: number } = {},
): Promise<CurateResult> {
  const hours = options.hours ?? 24;
  try {
    const { text, scanned } = await digests(harness, context, hours);
    if (scanned === 0) return { suggestions: [], scanned: 0, tokens: 0 };

    const [global, work] = await Promise.all([
      harness.snapshot(GlobalMemory, context),
      harness.snapshot(WorkMemory, context),
    ]);
    const known = [existingNotes(global?.notes ?? []), existingNotes(work?.notes ?? [])].join("\n");

    const model = models.getModel(config.model.provider, config.model.modelId);
    if (model === undefined) return { suggestions: [], scanned, tokens: 0, error: "no model" };

    const answer = await models.complete(model, {
      systemPrompt: PROMPT,
      messages: [
        {
          role: "user",
          content: `现有记忆（不要重复这些）：\n${known}\n\n最近 ${hours} 小时的对话：\n${text.slice(0, 24_000)}`,
          timestamp: Date.now(),
        },
      ],
    });

    const raw = (answer.content ?? [])
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const suggestions = parseSuggestions(raw);

    // Drop anything that already exists, and anything the owner deleted on purpose.
    const tombstones = (await harness.snapshot(MemoryTombstones, context))?.texts ?? [];
    const existing = (global?.notes ?? [])
      .concat(work?.notes ?? [])
      .concat(tombstones.map((text) => ({ at: "", text })))
      .map((note) => note.text);
    const fresh = suggestions.filter((suggestion) => !isDuplicate(suggestion.text, existing));

    log("curator", "suggestions produced", {
      scanned,
      suggested: suggestions.length,
      fresh: fresh.length,
      tokens: answer.usage?.totalTokens ?? 0,
    });
    return { suggestions: fresh, scanned, tokens: answer.usage?.totalTokens ?? 0 };
  } catch (error) {
    logError("curator", "curation failed", error);
    return { suggestions: [], scanned: 0, tokens: 0, error: (error as Error).message };
  }
}

/** Writes the accepted suggestions; global writes are capped harder than work. */
export async function applySuggestions(
  harness: Harness,
  context: Context,
  accepted: Suggestion[],
): Promise<{ added: number; skipped: number }> {
  const at = new Date().toISOString();
  let added = 0;
  let skipped = 0;
  await harness.commit(async (tx) => {
    const global = await tx.doc(GlobalMemory);
    const work = await tx.doc(WorkMemory);
    let globalAdded = 0;
    for (const suggestion of accepted) {
      const text = suggestion.text.trim();
      if (text.length < 6) {
        skipped += 1;
        continue;
      }
      const target = suggestion.scope === "global" ? global : work;
      const duplicate = isDuplicate(text, target.notes.map((note) => note.text));
      if (duplicate) {
        skipped += 1;
        continue;
      }
      if (suggestion.scope === "global" && globalAdded >= 3) {
        skipped += 1;
        continue;
      }
      target.notes.push({ at, text });
      added += 1;
      if (suggestion.scope === "global") globalAdded += 1;
    }
    return undefined;
  }, context);
  log("curator", "suggestions applied", { added, skipped });
  return { added, skipped };
}

export type { ChatMemory };
