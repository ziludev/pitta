import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

/**
 * Cards that were created for a turn but not finished yet. Kept durably because the
 * conversation resumes in a new process after a crash, while the card id only ever
 * lived in memory: without this, a restart leaves the user staring at "thinking".
 */
export type PendingCard = {
  cardId: string;
  chatId: string;
  conversationId: number;
  /** Set once the submission exists, so another process can wait for its answer. */
  submissionId?: number;
  /** The message that was answered: a recovered answer replies to it, not to the whole chat. */
  messageId?: string;
  /** Whether that message lives in a topic, so the recovered answer lands inside it too. */
  thread?: boolean;
  /** Recovery attempts so far. A card that keeps failing is dropped instead of retried forever. */
  attempts?: number;
  /** Who took the card for delivery. Two boots in a row both waited for the same answer and both
   * replied with it; the claim is committed before anything is sent, so only one of them does. */
  claimedBy?: string;
  at: number;
};

export const PendingCards = defineDoc<{ cards: Record<string, PendingCard> }>({
  kind: "app.pending-cards",
  version: 1,
  scope: "session",
  initial: () => ({ cards: {} }),
  checkpointWhen: () => false,
});

export async function markCardPending(
  harness: Harness,
  context: Context,
  requestId: string,
  card: Omit<PendingCard, "at">,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    doc.cards[requestId] = { ...card, at: Date.now() };
  }, context);
}

export async function attachSubmission(
  harness: Harness,
  context: Context,
  requestId: string,
  submissionId: number,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    const current = doc.cards[requestId];
    if (current !== undefined) current.submissionId = submissionId;
  }, context);
}

export async function clearCardPending(
  harness: Harness,
  context: Context,
  requestId: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    delete doc.cards[requestId];
  }, context);
}

/**
 * Counts one recovery attempt. A card whose cleanup never lands — the process dies again
 * before the commit, or Feishu rejects its ids forever — would otherwise be attempted on
 * every boot, with two failed API calls each time.
 */
export async function noteCardAttempt(
  harness: Harness,
  context: Context,
  requestId: string,
): Promise<number> {
  let attempts = 1;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    const current = doc.cards[requestId];
    if (current === undefined) return;
    current.attempts = (current.attempts ?? 0) + 1;
    attempts = current.attempts;
  }, context);
  return attempts;
}

/**
 * Takes the card for delivery, atomically. Returns false when another process already took it.
 */
export async function claimCard(
  harness: Harness,
  context: Context,
  requestId: string,
  owner: string,
): Promise<boolean> {
  let claimed = false;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    const current = doc.cards[requestId];
    if (current === undefined || current.claimedBy !== undefined) return;
    current.claimedBy = owner;
    claimed = true;
  }, context);
  return claimed;
}

/**
 * Whether a card is still marked pending. The live turn clears the mark in its `finally`, right after
 * it delivers — so a recovery that finds the mark gone has nothing left to deliver.
 */
export async function isCardPending(harness: Harness, context: Context, requestId: string): Promise<boolean> {
  const doc = await harness.snapshot(PendingCards, context).catch(() => undefined);
  return doc !== undefined && doc.cards[requestId] !== undefined;
}

/** Cards left over from a previous process, oldest first. Cards created at or after `before` belong
 * to this process: a turn that started while the recovery loop was reading would otherwise be
 * treated as a leftover, and its already-finished submission delivered a second time. */
export async function leftoverCards(
  harness: Harness,
  context: Context,
  before: number,
): Promise<Array<{ requestId: string } & PendingCard>> {
  const doc = await harness.snapshot(PendingCards, context);
  if (doc === undefined) return [];
  return Object.entries(doc.cards)
    .map(([requestId, value]) => ({ requestId, ...value }))
    .filter((card) => card.at < before)
    .sort((a, b) => a.at - b.at);
}
