import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

export type ToolStep = {
  name: string;
  ok: boolean;
  /** Short output preview so the owner can see what actually happened. */
  preview: string;
};

export type TurnDetails = {
  steps: ToolStep[];
  seconds: number;
  costUsd: number;
  at: number;
};

/**
 * Per-message record of what the agent actually did. Feishu cards cannot be
 * expanded in place, so the "查看详情" button reads this instead of re-running
 * anything.
 */
export const TurnDetailsDoc = defineDoc<{ turns: Record<string, TurnDetails> }>({
  kind: "app.turn-details",
  version: 1,
  scope: "session",
  initial: () => ({ turns: {} }),
  checkpointWhen: () => false,
});

const MAX_TURNS = 200;

export async function saveTurnDetails(
  harness: Harness,
  context: Context,
  messageId: string,
  details: Omit<TurnDetails, "at">,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(TurnDetailsDoc);
    doc.turns[messageId] = { ...details, at: Date.now() };
    const keys = Object.keys(doc.turns);
    if (keys.length > MAX_TURNS) {
      for (const key of keys.slice(0, keys.length - MAX_TURNS)) delete doc.turns[key];
    }
  }, context);
}

export async function readTurnDetails(
  harness: Harness,
  context: Context,
  messageId: string,
): Promise<TurnDetails | undefined> {
  const doc = await harness.snapshot(TurnDetailsDoc, context);
  return doc?.turns[messageId];
}
