import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

/**
 * Cards that were created for a turn but not finished yet. Kept durably because the
 * conversation resumes in a new process after a crash, while the card id only ever
 * lived in memory: without this, a restart leaves the user staring at "thinking".
 */
/**
 * Where a turn's card stands. The live turn holds `live` while it streams patches. A recovery after
 * a restart takes `live` atomically and moves it to `delivering` before it posts anything, so two
 * processes cannot both answer the same card. Deleting the record is the terminal state: the answer
 * is out, or the card was abandoned.
 *
 *   live ──(the run settled, or a recovery adopted it)──▶ delivering ──(answer posted)──▶ gone
 *     └──(never submitted, or three failed attempts)──────────────────────────────────────▶ gone
 */
export type CardPhase = "live" | "delivering";

export type PendingCard = {
  cardId: string;
  chatId: string;
  conversationId: number;
  /** Absent on records written before the phase existed; read it through phaseOf(). */
  phase?: CardPhase;
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

export function phaseOf(card: PendingCard): CardPhase {
  return card.phase ?? "live";
}

export async function markCardPending(
  harness: Harness,
  context: Context,
  requestId: string,
  card: Omit<PendingCard, "at" | "phase">,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    doc.cards[requestId] = { ...card, phase: "live", at: Date.now() };
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
 * Takes the card for delivery, atomically: only a card still in `from` moves, and only the actor
 * that moved it proceeds. This one transition replaces the pair of guards that used to sit in front
 * of the recovery (a pending check and a claim); a losing actor learns the phase it found instead of
 * guessing, and a missing record — reported as `gone` — means the live turn already delivered.
 */
export async function moveCard(
  harness: Harness,
  context: Context,
  requestId: string,
  from: CardPhase,
  to: CardPhase,
  owner?: string,
): Promise<{ moved: boolean; found: CardPhase | "gone" }> {
  let moved = false;
  let found: CardPhase | "gone" = "gone";
  await harness.commit(async (tx) => {
    const doc = await tx.doc(PendingCards);
    const current = doc.cards[requestId];
    if (current === undefined) return;
    found = phaseOf(current);
    if (found !== from) return;
    current.phase = to;
    if (owner !== undefined) current.claimedBy = owner;
    moved = true;
  }, context);
  return { moved, found };
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
