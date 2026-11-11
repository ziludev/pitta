import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { log } from "./log.ts";

/**
 * Chats where anyone may talk to the agent, not just the owner. Used for shared
 * groups: access is granted per chat, and the conversation gets a guest policy that
 * keeps the owner's personal memory out of the prompt.
 */
export const GuestChats = defineDoc<{ ids: string[] }>({
  kind: "app.guest-chats",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => false,
});

/** Per-conversation policy: a guest conversation never sees global memory. */
export const ChatPolicy = defineDoc<{ guest: boolean }>({
  kind: "app.chat-policy",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ guest: false }),
  checkpointWhen: () => false,
});

export async function guestChatIds(harness: Harness, context: Context): Promise<string[]> {
  return (await harness.snapshot(GuestChats, context))?.ids ?? [];
}

export async function markGuestChat(harness: Harness, context: Context, chatId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(GuestChats);
    if (!doc.ids.includes(chatId)) doc.ids.push(chatId);
  }, context);
  log("feishu", "chat opened to all senders", { chatId });
}

export async function setGuestPolicy(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ChatPolicy, conversationId as never);
    doc.guest = true;
  }, context);
}

export async function isGuestConversation(
  read: { snapshot: (token: unknown, conversationId: never, context: Context) => Promise<{ guest: boolean } | undefined> },
  conversationId: number,
  context: Context,
): Promise<boolean> {
  const policy = await read.snapshot(ChatPolicy, conversationId as never, context).catch(() => undefined);
  return policy?.guest === true;
}
