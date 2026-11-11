import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import { ELIDE_MIN_CHARS, KEEP_RECENT, elideOldToolOutputs } from "../src/context-guard.ts";

/**
 * A long diagnosis keeps every tool result in the request until compaction. The guard replaces the
 * older ones with a line saying what they were — never the recent ones, and only once a request is
 * already big, so an ordinary turn is not rewritten.
 */

const toolResult = (id: string, chars: number): Message =>
  ({
    role: "toolResult",
    toolCallId: id,
    toolName: "bash",
    content: [{ type: "text", text: "x".repeat(chars) }],
  }) as unknown as Message;

const user = { role: "user", content: "hi" } as unknown as Message;

test("a small request is left alone", () => {
  const messages = [user, ...Array.from({ length: 20 }, (_, index) => toolResult(`c${index}`, 1_000))];
  const { messages: next, elided } = elideOldToolOutputs(messages);
  assert.equal(elided, 0);
  assert.equal(next.length, messages.length);
});

test("older, large tool results are elided and the recent ones are not", () => {
  const total = KEEP_RECENT + 6;
  const messages = [user, ...Array.from({ length: total }, (_, i) => toolResult(`c${i}`, 8_000))];
  const { messages: next, elided } = elideOldToolOutputs(messages);
  assert.equal(elided, 6, "only the six beyond the kept window");
  const textOf = (message: Message): string =>
    JSON.stringify((message as { content?: unknown }).content ?? "");
  assert.match(textOf(next[1] as Message), /较早的工具输出已省略：bash/);
  const last = next[next.length - 1] as Message;
  assert.equal(textOf(last).includes("较早的工具输出已省略"), false, "the newest result is untouched");
});

test("a small old result is kept as it is", () => {
  const messages = [user, ...Array.from({ length: KEEP_RECENT + 1 }, (_, i) => toolResult(`c${i}`, 4_000))];
  messages[1] = toolResult("small", 50);
  const { elided } = elideOldToolOutputs(messages);
  assert.equal(elided, 0, "nothing worth eliding");
  assert.ok(ELIDE_MIN_CHARS > 0);
});
