import assert from "node:assert/strict";
import { test } from "node:test";
import { markCardPending, moveCard, phaseOf, type PendingCard } from "../src/cards.ts";

/**
 * The card phase is the guard that stands between a finished turn and a second delivery of the same
 * answer: two boots after a restart both waited on one submission and both replied with it. Only the
 * process that moves `live → delivering` may post, and the one transition is what enforces it.
 */
type State = { cards: Record<string, PendingCard> };

/** Just enough harness for these transitions: one doc, commits applied in place. */
function fake(): { harness: never; state: State } {
  const state: State = { cards: {} };
  const harness = {
    commit: async (fn: (tx: { doc: (d: unknown) => Promise<State> }) => Promise<void>) => {
      assert.equal(typeof fn, "function");
      await fn({ doc: async () => state });
    },
    snapshot: async () => state,
  };
  return { harness: harness as never, state };
}

const context = {} as never;

async function seed(harness: never, requestId: string): Promise<void> {
  await markCardPending(harness, context, requestId, {
    cardId: "om_card",
    chatId: "oc_chat",
    conversationId: 7,
  });
}

test("a fresh card is live and carries no phase drift", async () => {
  const { harness, state } = fake();
  await seed(harness, "req-1");
  assert.equal(phaseOf(state.cards["req-1"]), "live");
});

test("only one of two processes moves the card to delivering", async () => {
  const { harness, state } = fake();
  await seed(harness, "req-2");
  const first = await moveCard(harness, context, "req-2", "live", "delivering", "recover:1");
  const second = await moveCard(harness, context, "req-2", "live", "delivering", "recover:2");
  assert.deepEqual(first, { moved: true, found: "live" });
  assert.deepEqual(second, { moved: false, found: "delivering" });
  assert.equal(state.cards["req-2"]?.claimedBy, "recover:1");
  assert.equal(phaseOf(state.cards["req-2"] as PendingCard), "delivering");
});

test("a record the live turn already cleared reports gone instead of a delivery", async () => {
  const { harness, state } = fake();
  const taken = await moveCard(harness, context, "req-3", "live", "delivering", "recover:1");
  assert.deepEqual(taken, { moved: false, found: "gone" });
  assert.deepEqual(state.cards, {});
});

test("a record written before phases existed counts as live", async () => {
  const { harness, state } = fake();
  state.cards["req-4"] = { cardId: "om_card", chatId: "oc_chat", conversationId: 7, at: Date.now() };
  assert.equal(phaseOf(state.cards["req-4"] as PendingCard), "live");
  const taken = await moveCard(harness, context, "req-4", "live", "delivering");
  assert.equal(taken.moved, true);
});

test("an unrelated transition leaves the card where it was", async () => {
  const { harness, state } = fake();
  await seed(harness, "req-5");
  const wrong = await moveCard(harness, context, "req-5", "delivering", "live");
  assert.deepEqual(wrong, { moved: false, found: "live" });
  assert.equal(phaseOf(state.cards["req-5"] as PendingCard), "live");
  assert.equal(state.cards["req-5"]?.claimedBy, undefined);
});
