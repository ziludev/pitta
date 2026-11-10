import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { log } from "./log.ts";

/**
 * Risk classes the owner allowed for the rest of one conversation ("本会话内全部允许").
 * A chat that is deliberately editing a repo outside the workspace should not raise the
 * same card for every file; the grant is per conversation and per class, never global.
 */
export const SessionGrants = defineDoc<{ byConversation: Record<string, string[]> }>({
  kind: "app.session-grants",
  version: 1,
  scope: "session",
  initial: () => ({ byConversation: {} }),
  checkpointWhen: () => false,
});

/** Cached so the guard does not read the doc on every tool call. */
const cache = new Map<string, Set<string>>();
let loaded = false;

export async function loadGrants(harness: Harness, context: Context): Promise<void> {
  const doc = await harness.snapshot(SessionGrants, context);
  cache.clear();
  for (const [conversationId, keys] of Object.entries(doc?.byConversation ?? {})) {
    cache.set(String(conversationId), new Set(keys));
  }
  loaded = true;
}

export function hasGrant(conversationId: number, key: string): boolean {
  return loaded && cache.get(String(conversationId))?.has(key) === true;
}

export function rememberGrant(conversationId: number, key: string): void {
  const set = cache.get(String(conversationId)) ?? new Set<string>();
  set.add(key);
  cache.set(String(conversationId), set);
}

export async function grantSession(
  harness: Harness,
  context: Context,
  conversationId: number,
  key: string,
): Promise<void> {
  rememberGrant(conversationId, key);
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SessionGrants);
    const id = String(conversationId);
    const keys = new Set(doc.byConversation[id] ?? []);
    keys.add(key);
    doc.byConversation[id] = [...keys];
  }, context);
  log("approval", "session grant", { conversationId, key });
}

export async function grantsOf(harness: Harness, context: Context, conversationId: number): Promise<string[]> {
  const doc = await harness.snapshot(SessionGrants, context);
  return doc?.byConversation[String(conversationId)] ?? [];
}

export async function clearGrants(harness: Harness, context: Context, conversationId: number): Promise<void> {
  cache.delete(String(conversationId));
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SessionGrants);
    delete doc.byConversation[String(conversationId)];
  }, context);
}
