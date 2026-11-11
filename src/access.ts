import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { log } from "./log.ts";

/**
 * One state decides who may use a Feishu chat and at what level.
 *
 * - `closed` — nobody; a chat the bot was added to, or a person it has never met.
 * - `owner`  — only the owner. A chat listed in `.env`, and the owner's own DM.
 * - `group`  — everyone in it, with the guest tool surface and the group's own memory.
 *
 * Gate, guest policy, tool surface and `/allow` all read this one value. Before, three docs
 * (`.env` chat list, `app.allowed-chats`, `app.guest-chats`) and a derived rule answered the
 * same question, and which one won depended on where you looked.
 */
export type ChatLevel = "closed" | "owner" | "group";

export const ChatAccess = defineDoc<{ chats: Record<string, ChatLevel> }>({
  kind: "app.chat-access",
  version: 1,
  scope: "session",
  initial: () => ({ chats: {} }),
  checkpointWhen: () => false,
});

/** The level for one chat. `.env` is the fallback for chats this process has not stored yet. */
export function levelOf(chatId: string, access: Record<string, ChatLevel>, envChatIds: readonly string[] = []): ChatLevel {
  const stored = access[chatId];
  if (stored !== undefined) return stored;
  return envChatIds.includes(chatId) ? "owner" : "closed";
}

export function isGuestLevel(level: ChatLevel): boolean {
  return level === "group";
}

export async function chatAccess(harness: Harness, context: Context): Promise<Record<string, ChatLevel>> {
  return (await harness.snapshot(ChatAccess, context).catch(() => undefined))?.chats ?? {};
}

export async function setChatLevel(
  harness: Harness,
  context: Context,
  chatId: string,
  level: ChatLevel,
): Promise<void> {
  await harness.commit(async (tx) => {
    (await tx.doc(ChatAccess)).chats[chatId] = level;
  }, context);
  log("access", "chat level set", { chatId, level });
}

/** Docs from before the single state; read once, then nothing writes them again. */
const LegacyGuestChats = defineDoc<{ ids: string[] }>({
  kind: "app.guest-chats",
  version: 1,
  scope: "session",
  initial: () => ({ ids: [] }),
  checkpointWhen: () => false,
});

const LegacyAllowedChats = defineDoc<{ extra: string[] }>({
  kind: "app.allowed-chats",
  version: 1,
  scope: "session",
  initial: () => ({ extra: [] }),
  checkpointWhen: () => false,
});

/**
 * Runs once at bridge start: imports the chats the previous model stored, and the chats
 * configured in `.env`, so an upgrade never silently closes a group the owner opened.
 */
export async function adoptChatLevels(
  harness: Harness,
  context: Context,
  envChatIds: readonly string[],
): Promise<Record<string, ChatLevel>> {
  const current = await chatAccess(harness, context);
  const next: Record<string, ChatLevel> = { ...current };
  const groups: string[] = [];
  const owners: string[] = [];
  const adopt = (chatId: string, level: ChatLevel, changed: string[]): void => {
    if (next[chatId] !== undefined) return;
    next[chatId] = level;
    changed.push(chatId);
  };

  // `/allow` and `/open` both opened a group before; both were guest by the end.
  const legacyGuests = (await harness.snapshot(LegacyGuestChats, context).catch(() => undefined))?.ids ?? [];
  const legacyAllowed = (await harness.snapshot(LegacyAllowedChats, context).catch(() => undefined))?.extra ?? [];
  for (const chatId of [...legacyGuests, ...legacyAllowed]) adopt(chatId, "group", groups);
  for (const chatId of envChatIds) adopt(chatId, "owner", owners);

  if (groups.length > 0 || owners.length > 0) {
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ChatAccess);
      for (const chatId of [...groups, ...owners]) {
        if (doc.chats[chatId] === undefined) doc.chats[chatId] = next[chatId] as ChatLevel;
      }
    }, context);
    log("access", "adopted chat levels", { groups, owners });
  }
  return next;
}

/** Per-conversation policy: guest conversations never see the owner's memory. */
export const ChatPolicy = defineDoc<{ guest: boolean; topic?: string; turn?: "owner" | "guest" }>({
  kind: "app.chat-policy",
  version: 1,
  scope: "conversation",
  history: "latest",
  fork: "current",
  initial: () => ({ guest: false }),
  checkpointWhen: () => false,
});

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

/**
 * Marks whose turn the conversation is about to run, so the guard hook can decide the tool
 * surface without trusting a prompt. Absent means guest: a resumed turn defaults to the safe side.
 */
export async function setChatTurn(
  harness: Harness,
  context: Context,
  conversationId: number,
  turn: "owner" | "guest",
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ChatPolicy, conversationId as never);
    doc.turn = turn;
  }, context);
}

/** The /open rule for one conversation, re-applied as instructions on every turn. */
export async function setChatTopic(
  harness: Harness,
  context: Context,
  conversationId: number,
  topic: string | undefined,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ChatPolicy, conversationId as never);
    if (topic === undefined) delete doc.topic;
    else doc.topic = topic;
  }, context);
}

export async function chatTopicOf(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<string | undefined> {
  const policy = await harness.snapshot(ChatPolicy, conversationId as never, context).catch(() => undefined);
  return policy?.topic;
}

export async function isGuestConversation(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<boolean> {
  const policy = await harness.snapshot(ChatPolicy, conversationId as never, context).catch(() => undefined);
  return policy?.guest === true;
}

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
  log("access", "owner chat recorded", { chatId });
}
