import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { log } from "./log.ts";

/**
 * Chats authorized from inside Feishu (`/allow`), on top of the .env allowlist.
 * Config cannot know a chat id before the bot has been added to the group, so the
 * owner can authorize one from the chat itself. Senders are still gated by
 * FEISHU_ALLOWED_SENDER_IDS, so only the owner can do this.
 */
export const AllowedChats = defineDoc<{ extra: string[] }>({
  kind: "app.allowed-chats",
  version: 1,
  scope: "session",
  initial: () => ({ extra: [] }),
  checkpointWhen: () => false,
});

/**
 * The owner's own p2p chat, learned from the first message they send. Needed to report
 * strangers: their chat id is new to us, so it cannot be the address we send to.
 */
export const OwnerChat = defineDoc<{ chatId?: string }>({
  kind: "app.owner-chat",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => false,
});

let cachedOwnerChat: string | undefined;

export async function ownerChatId(harness: Harness, context: Context): Promise<string | undefined> {
  if (cachedOwnerChat !== undefined) return cachedOwnerChat;
  const doc = await harness.snapshot(OwnerChat, context);
  cachedOwnerChat = doc?.chatId;
  return cachedOwnerChat;
}

export async function rememberOwnerChat(harness: Harness, context: Context, chatId: string): Promise<void> {
  if (cachedOwnerChat === chatId) return;
  cachedOwnerChat = chatId;
  await harness.commit(async (tx) => {
    (await tx.doc(OwnerChat)).chatId = chatId;
  }, context);
  log("feishu", "owner chat recorded", { chatId });
}

export async function extraChats(harness: Harness, context: Context): Promise<string[]> {
  return (await harness.snapshot(AllowedChats, context))?.extra ?? [];
}

export async function allowChat(harness: Harness, context: Context, chatId: string): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(AllowedChats);
    if (!doc.extra.includes(chatId)) doc.extra.push(chatId);
  }, context);
  log("feishu", "chat authorized from Feishu", { chatId });
}
