import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";

/** Spend tracked per local day, with the session total as the baseline. */
export const DailySpend = defineDoc<{
  date: string;
  baseline: number;
  spent: number;
  limit: number;
}>({
  kind: "app.daily-spend",
  version: 1,
  scope: "session",
  initial: () => ({ date: "", baseline: 0, spent: 0, limit: 0 }),
  checkpointWhen: () => false,
});

function today(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

function totalCost(usage: { models: Record<string, unknown>; tools: Record<string, unknown> }): number {
  let total = 0;
  for (const bucket of [usage.models, usage.tools]) {
    for (const entry of Object.values(bucket)) {
      const cost = (entry as { cost?: Record<string, number> }).cost;
      if (cost === undefined) continue;
      total +=
        cost["total"] ?? (cost["input"] ?? 0) + (cost["output"] ?? 0) + (cost["cacheRead"] ?? 0) + (cost["cacheWrite"] ?? 0);
    }
  }
  return total;
}

export type BudgetCheck = {
  allowed: boolean;
  spentToday: number;
  limit: number;
};

/** Rolls the counter over at midnight and refreshes `spent` from the session total. */
export async function checkBudget(
  harness: Harness,
  context: Context,
  limit: number,
): Promise<BudgetCheck> {
  const usage = await harness.usage(context);
  const cost = totalCost(usage as unknown as { models: Record<string, unknown>; tools: Record<string, unknown> });
  const date = today();

  const state = await harness.commit(async (tx) => {
    const doc = await tx.doc(DailySpend);
    if (doc.date !== date) {
      doc.date = date;
      doc.baseline = cost;
      doc.spent = 0;
    }
    doc.limit = limit;
    doc.spent = Math.max(0, cost - doc.baseline);
    return { spent: doc.spent, limit: doc.limit };
  }, context);

  return { allowed: state.limit <= 0 || state.spent < state.limit, spentToday: state.spent, limit: state.limit };
}
