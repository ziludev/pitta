import { defineExtension, hook, GenerationTask } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { log } from "./log.ts";

/**
 * Keep a long run's context from filling with tool output nobody reads again.
 *
 * The real failures here were 40-turn diagnoses where the same log query and the same `git show`
 * came back several times: every result stayed in the request until compaction, so each later
 * request carried all of them. This does not summarise or rewrite content — it replaces the *older*
 * tool outputs with one line saying where they went, and only once a request is already large, so
 * an ordinary turn is untouched and the model can re-run a tool it still needs.
 */

/** Tool results kept verbatim at the end of the request. */
export const KEEP_RECENT = 12;
/** Below this many characters of tool output, nothing is touched. */
export const ELIDE_MIN_CHARS = 60_000;
/** What a placeholder keeps of the original: enough to recognise, not enough to pay for. */
const PREVIEW_CHARS = 200;

const PLACEHOLDER = (name: string, chars: number) =>
  `[较早的工具输出已省略：${name}，原文约 ${Math.round(chars / 100) / 10}k 字符。需要时重新运行这个工具]`;

export function elideOldToolOutputs(
  messages: readonly Message[],
  keep = KEEP_RECENT,
  minChars = ELIDE_MIN_CHARS,
): { messages: Message[]; elided: number } {
  const results = messages
    .map((message, index) => ({ message, index }))
    .filter((entry) => entry.message.role === "toolResult");
  if (results.length <= keep) return { messages: [...messages], elided: 0 };

  const size = (message: Message): number => {
    const content = (message as { content?: unknown }).content;
    if (typeof content === "string") return content.length;
    if (!Array.isArray(content)) return 0;
    return content.reduce((sum, part) => sum + String((part as { text?: string }).text ?? "").length, 0);
  };
  const total = results.reduce((sum, entry) => sum + size(entry.message), 0);
  if (total < minChars) return { messages: [...messages], elided: 0 };

  const stale = new Set(results.slice(0, results.length - keep).map((entry) => entry.index));
  let elided = 0;
  const next = messages.map((message, index) => {
    if (!stale.has(index)) return message;
    const chars = size(message);
    if (chars <= PREVIEW_CHARS) return message;
    elided += 1;
    const name = String((message as { toolName?: string }).toolName ?? "tool");
    return { ...message, content: [{ type: "text" as const, text: PLACEHOLDER(name, chars) }] } as Message;
  });
  return { messages: next, elided };
}

export const contextGuardExtension = defineExtension({
  name: "context-guard",
  hooks: [
    hook(GenerationTask, {
      beforeRequest: (request) => {
        const { messages, elided } = elideOldToolOutputs(request.messages);
        if (elided === 0) return undefined;
        log("context", "elided old tool output", { elided, messages: messages.length });
        return { messages };
      },
    }),
  ],
});
