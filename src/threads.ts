import { defineDoc, type Conversation, type EntryId, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

/**
 * message id -> the transcript entry it produced. Needed to fork a reply at the
 * exact point it answers, and to survive restarts (a thread keeps its parent).
 */
export const MessageIndex = defineDoc<{
  messages: Record<string, { conversationId: number; entryId: number; at: number }>;
}>({
  kind: "app.message-index",
  version: 1,
  scope: "session",
  initial: () => ({ messages: {} }),
  checkpointWhen: () => false,
});

/** thread key -> its forked conversation. */
export const ThreadMap = defineDoc<{
  threads: Record<string, { conversationId: number; at: number }>;
}>({
  kind: "app.threads",
  version: 1,
  scope: "session",
  initial: () => ({ threads: {} }),
  checkpointWhen: () => false,
});

const MAX_ENTRIES = 500;

export async function recordMessage(
  harness: Harness,
  context: Context,
  messageId: string,
  conversationId: number,
  entryId: number,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(MessageIndex);
    doc.messages[messageId] = { conversationId, entryId, at: Date.now() };
    const keys = Object.keys(doc.messages);
    if (keys.length > MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete doc.messages[key];
    }
  }, context);
}

export async function lookupMessage(
  harness: Harness,
  context: Context,
  messageId: string,
): Promise<{ conversationId: number; entryId: number } | undefined> {
  const doc = await harness.snapshot(MessageIndex, context);
  const hit = doc?.messages[messageId];
  return hit === undefined ? undefined : { conversationId: hit.conversationId, entryId: hit.entryId };
}

export async function recordThread(
  harness: Harness,
  context: Context,
  threadKey: string,
  conversationId: number,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ThreadMap);
    doc.threads[threadKey] = { conversationId, at: Date.now() };
    const keys = Object.keys(doc.threads);
    if (keys.length > MAX_ENTRIES) {
      for (const key of keys.slice(0, keys.length - MAX_ENTRIES)) delete doc.threads[key];
    }
  }, context);
}

export async function lookupThread(
  harness: Harness,
  context: Context,
  threadKey: string,
): Promise<number | undefined> {
  const doc = await harness.snapshot(ThreadMap, context);
  return doc?.threads[threadKey]?.conversationId;
}

/**
 * Fork a conversation at one entry. The fork sees the parent's history up to that
 * point without copying it, and runs independently from then on.
 */
export async function forkAt(
  parent: Conversation,
  entryId: number,
  agent: Record<string, unknown>,
  context: Context,
): Promise<Conversation> {
  return parent.fork(entryId as unknown as EntryId, { ownership: { kind: "ownerless" }, agent }, context);
}
