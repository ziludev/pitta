import type { Conversation } from "@earendil-works/pi-durable";
import { context } from "./harness.ts";

export type LiveSnapshot = {
  /** Text committed so far of the answer being streamed. */
  text: string;
  /** Human-readable label of the tool round currently running. */
  tools: string[];
  busy: boolean;
};

type Json = Record<string, unknown>;

function asRecord(value: unknown): Json | undefined {
  return typeof value === "object" && value !== null ? (value as Json) : undefined;
}

function textOfMessage(message: unknown): string {
  const record = asRecord(message);
  const content = record?.["content"];
  if (!Array.isArray(content)) return "";
  let text = "";
  for (const part of content) {
    const item = asRecord(part);
    if (item?.["type"] === "text" && typeof item["text"] === "string") text += item["text"];
  }
  return text;
}

/** Reads `pi.live` out of a conversation view. */
export function readLive(view: unknown): LiveSnapshot {
  const docs = asRecord(asRecord(view)?.["docs"]);
  const live = asRecord(docs?.["pi.live"]);
  if (live === undefined) return { text: "", tools: [], busy: false };

  const generation = asRecord(live["generation"]);
  const text = textOfMessage(generation?.["message"]);

  const tools: string[] = [];
  const slots = live["tools"];
  if (Array.isArray(slots)) {
    for (const slot of slots) {
      const record = asRecord(slot);
      const name = record?.["name"];
      if (typeof name === "string") tools.push(name);
    }
  }

  return { text, tools, busy: live["run"] !== undefined };
}

export type LiveWatcher = { stop(): Promise<void> };

/**
 * Follows a conversation and reports the live snapshot on change.
 * Throttled: Feishu card updates are rate limited, so we push at most every `intervalMs`.
 */
export async function watchLive(
  conversation: Conversation,
  onSnapshot: (snapshot: LiveSnapshot) => void,
  options: { intervalMs?: number } = {},
): Promise<LiveWatcher> {
  const intervalMs = options.intervalMs ?? 1500;
  const watch = await conversation.watch(context);
  let latest = readLive(watch.value);
  let lastPush = 0;
  let timer: NodeJS.Timeout | undefined;

  const push = () => {
    lastPush = Date.now();
    onSnapshot(latest);
  };

  push();
  watch.start(async (call) => {
    if (call.kind !== "value") return;
    latest = readLive(call.value);
    const elapsed = Date.now() - lastPush;
    if (elapsed >= intervalMs) {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      push();
      return;
    }
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      push();
    }, intervalMs - elapsed);
  });

  return {
    async stop() {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      await watch.stop();
    },
  };
}
