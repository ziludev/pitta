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

/** Cards left over from a previous process, oldest first. */
export async function leftoverCards(
  harness: Harness,
  context: Context,
): Promise<Array<{ requestId: string } & PendingCard>> {
  const doc = await harness.snapshot(PendingCards, context);
  if (doc === undefined) return [];
  return Object.entries(doc.cards)
    .map(([requestId, value]) => ({ requestId, ...value }))
    .sort((a, b) => a.at - b.at);
}
