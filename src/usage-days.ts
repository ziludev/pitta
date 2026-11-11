import { defineDoc, defineTask, UsageDoc, type Harness, type TaskRuntime } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { log, logError } from "./log.ts";

export type DayUsage = {
  /** Cumulative totals across every conversation, at the last sample of that day. */
  cost: number;
  tokens: number;
  input: number;
  output: number;
};

/**
 * One cumulative snapshot per day. Per-day spend is the difference between
 * consecutive snapshots, so the sampler only ever needs to write "the total right
 * now" — no per-request accounting, no hook that cannot commit.
 */
export const UsageDays = defineDoc<{
  days: Record<string, DayUsage>;
  /** Lifetime totals when the sampler first ran: everything before it is not ours to chart. */
  baseline?: { cost: number; tokens: number; input: number; output: number };
}>({
  kind: "app.usage-days",
  version: 1,
  scope: "session",
  initial: () => ({ days: {} }),
  checkpointWhen: () => false,
});

export const SAMPLE_INTERVAL_MS = 10 * 60 * 1000;

function localDate(at = Date.now()): string {
  return new Date(at).toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
}

type Bucket = {
  cost?: { total?: number };
  totalTokens?: number;
  input?: number;
  output?: number;
};

function addUsage(bucket: Bucket, into: { cost: number; tokens: number; input: number; output: number }): void {
  into.cost += bucket.cost?.["total"] ?? 0;
  into.tokens += bucket.totalTokens ?? 0;
  into.input += bucket.input ?? 0;
  into.output += bucket.output ?? 0;
}

/** Sums every conversation's usage ledger. Runs inside a transaction read. */
async function snapshotTotals(runtime: TaskRuntime<unknown, { phase: "sample" }, null, object>, context: Context) {
  let total = { cost: 0, tokens: 0, input: 0, output: 0 };
  let conversations = 0;
  const date = localDate();

  await runtime.commit(async (tx) => {
    const page = await tx.scanConversations({}, 500);
    for (const record of page.items) {
      const usage = await tx.doc(UsageDoc, record.id);
      conversations += 1;
      for (const bucket of Object.values(usage.models ?? {})) addUsage(bucket as unknown as Bucket, total);
      for (const bucket of Object.values(usage.tools ?? {})) addUsage(bucket as unknown as Bucket, total);
    }
    const doc = await tx.doc(UsageDays);
    if (doc.baseline === undefined) {
      doc.baseline = { cost: total.cost, tokens: total.tokens, input: total.input, output: total.output };
    }
    const previous = doc.days[date];
    // Keep the largest sample of the day: resets or restarts must not lose spend.
    doc.days[date] = {
      cost: Math.max(previous?.cost ?? 0, total.cost),
      tokens: Math.max(previous?.tokens ?? 0, total.tokens),
      input: Math.max(previous?.input ?? 0, total.input),
      output: Math.max(previous?.output ?? 0, total.output),
    };
    return undefined;
  }, context);

  log("usage", "sampled", { date, conversations, cost: Number(total.cost.toFixed(4)), tokens: total.tokens });
}

/** Samples spend every 10 minutes, forever, without holding a timer in memory. */
export const UsageSampler = defineTask<null, { phase: "sample" }, null>({
  name: "app.usage-sampler",
  version: 1,
  initial: () => ({ phase: "sample" }),
  phases: {
    sample: async (task, runtime, context) => {
      try {
        await snapshotTotals(runtime as never, context);
      } catch (error) {
        logError("usage", "sample failed", error);
      }
      await runtime.sleepUntil(Date.now() + SAMPLE_INTERVAL_MS, { phase: "sample" }, context);
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

/**
 * Records today's cumulative totals now. The background sampler keeps the daily
 * boundary accurate; the server calls this too so the UI never shows stale numbers.
 */
export async function sampleUsage(harness: Harness, context: Context): Promise<void> {
  const date = localDate();
  await harness.commit(async (tx) => {
    const total = { cost: 0, tokens: 0, input: 0, output: 0 };
    const page = await tx.scanConversations({}, 500);
    for (const record of page.items) {
      const usage = await tx.doc(UsageDoc, record.id);
      for (const bucket of Object.values(usage.models ?? {})) addUsage(bucket as unknown as Bucket, total);
      for (const bucket of Object.values(usage.tools ?? {})) addUsage(bucket as unknown as Bucket, total);
    }
    const doc = await tx.doc(UsageDays);
    if (doc.baseline === undefined) {
      doc.baseline = { cost: total.cost, tokens: total.tokens, input: total.input, output: total.output };
    }
    const previous = doc.days[date];
    doc.days[date] = {
      cost: Math.max(previous?.cost ?? 0, total.cost),
      tokens: Math.max(previous?.tokens ?? 0, total.tokens),
      input: Math.max(previous?.input ?? 0, total.input),
      output: Math.max(previous?.output ?? 0, total.output),
    };
  }, context);
}

/** Per-day spend derived from the cumulative snapshots. */
export async function usageCalendar(
  read: (
    context: Context,
  ) => Promise<{
    days: Record<string, DayUsage>;
    baseline?: { cost: number; tokens: number; input: number; output: number };
  } | undefined>,
  context: Context,
  days: number,
): Promise<Array<{ date: string; cost: number; tokens: number }>> {
  const doc = await read(context);
  const entries = Object.entries(doc?.days ?? {}).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return [];

  const out: Array<{ date: string; cost: number; tokens: number }> = [];
  // Start from the baseline: spend before the sampler existed must not land on day one.
  let previous: DayUsage | undefined =
    doc?.baseline === undefined
      ? undefined
      : { cost: doc.baseline.cost, tokens: doc.baseline.tokens, input: doc.baseline.input, output: doc.baseline.output };
  for (const [date, value] of entries) {
    const daily: DayUsage = {
      cost: Math.max(0, value.cost - (previous?.cost ?? 0)),
      tokens: Math.max(0, value.tokens - (previous?.tokens ?? 0)),
      input: Math.max(0, value.input - (previous?.input ?? 0)),
      output: Math.max(0, value.output - (previous?.output ?? 0)),
    };
    out.push({ date, cost: daily.cost, tokens: daily.tokens });
    previous = value;
  }
  return out.slice(-days);
}
