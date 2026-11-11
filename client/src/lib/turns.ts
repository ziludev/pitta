import type { Step, TurnStats } from "@/components/TurnRail";

/** 90s → "1m30s", 3 700ms → "3.7s": one clock format for headers and cards. */
export function clockOf(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds === 0 ? `${minutes}m` : `${minutes}m${seconds}s`;
}
import { partsOf, textOf } from "@/components/TurnRail";
import type { Entry } from "@/lib/api";
import { diffStats } from "@/lib/diff";

/** Grouping and accounting for turns, shared by the transcript and the usage panel. */
export type Turn = {
  id: number;
  anchor: Entry;
  user?: Entry;
  finals: Entry[];
  reports: Entry[];
  /** Display-only lines written by the agent (restart, correction, continuation). */
  notes: Entry[];
  internals: Entry[];
  steps: Step[];
  stats: TurnStats;
};

export const isThinkingOrTool = (entry: Entry): boolean => {
  const parts = partsOf(entry.model);
  const hasCall = parts.some((part) => part["type"] === "toolCall");
  const hasText = textOf(parts).trim().length > 0;
  if (entry.kind === "pi.tool-result") return true;
  if (entry.kind !== "pi.assistant") return false;
  // A tool-calling answer is machinery; a text answer is the answer.
  return hasCall || !hasText;
};

/** "bash · pnpm test" or "思考 · 1.2k": one readable line per step. */
export function stepText(entry: Entry, call: Record<string, unknown> | undefined): string {
  if (call !== undefined) {
    const name = String(call["name"] ?? "tool");
    const args = call["arguments"] as Record<string, unknown> | undefined;
    const value = ["command", "path", "query", "url", "pattern"]
      .map((key) => args?.[key])
      .find((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
    return value === undefined ? name : `${name} · ${value.replace(/\s+/g, " ").slice(0, 46)}`;
  }
  const thinking = partsOf(entry.model)
    .filter((part) => part["type"] === "thinking")
    .map((part) => String(part["thinking"] ?? ""))
    .join("");
  return thinking.length > 0 ? `思考 · ${(thinking.length / 1000).toFixed(1)}k` : "思考";
}

/** Plain text of an entry, for in-conversation search. */
export function entryText(entry: Entry): string {
  const parts = partsOf(entry.model);
  const payload = (entry.data ?? {}) as { text?: string };
  return `${textOf(parts)} ${payload.text ?? ""}`.trim();
}

export function timestampOf(entry: Entry): number | undefined {
  const messages = Array.isArray(entry.model) ? (entry.model as Array<Record<string, unknown>>) : [];
  const stamped = messages.find((message) => typeof message["timestamp"] === "number");
  return stamped === undefined ? undefined : (stamped["timestamp"] as number);
}

/** Groups the transcript into turns: user message → machinery → answer. */
export function groupTurns(
  entries: Entry[],
  waits: Array<{ start: number; end: number }> = [],
): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;

  for (const entry of entries) {
    if (entry.kind === "pi.system") continue;

    // A note belongs to the turn it was written in; with no turn yet it opens one.
    if (entry.kind === "app.note" && current !== undefined) {
      current.notes.push(entry);
      continue;
    }

    if (entry.kind === "pi.user" || entry.kind === "app.feature-report" || current === undefined) {
      current = {
        id: entry.id,
        anchor: entry,
        user: entry.kind === "pi.user" ? entry : undefined,
        finals: [],
        reports: entry.kind === "app.feature-report" ? [entry] : [],
        notes: entry.kind === "app.note" ? [entry] : [],
        internals: [],
        steps: [],
        stats: { tools: 0, files: 0, added: 0, removed: 0, phases: { think: 0, tool: 0, error: 0, wait: 0 } },
      };
      turns.push(current);
      continue;
    }

    if (isThinkingOrTool(entry)) current.internals.push(entry);
    else current.finals.push(entry);
  }

  for (const turn of turns) {
    const timestamps = [turn.anchor, ...turn.internals, ...turn.finals]
      .map(timestampOf)
      .filter((value): value is number => value !== undefined);

    // Steps: a tool call runs from its own entry to its result; a thinking-only answer
    // runs to the next entry. Both carry the numbers the timeline needs.
    const timeline = [...turn.internals, ...turn.finals].filter((entry) => entry.kind === "pi.assistant");
    const results = new Map<string, Entry>();
    for (const entry of turn.internals) {
      if (entry.kind !== "pi.tool-result") continue;
      const parts = partsOf(entry.model);
      const callId = String(parts[0]?.["toolCallId"] ?? "");
      if (callId.length > 0) results.set(callId, entry);
    }

    const steps: Step[] = [];
    const phases = { think: 0, tool: 0, error: 0, wait: 0 };
    for (const [index, entry] of timeline.entries()) {
      const parts = partsOf(entry.model);
      const call = parts.find((part) => part["type"] === "toolCall");
      const start = timestampOf(entry) ?? turn.stats.start ?? 0;
      const next = timeline[index + 1];
      const result = call === undefined ? undefined : results.get(String(call["id"] ?? ""));
      const end =
        result !== undefined
          ? (timestampOf(result) ?? start)
          : next === undefined
            ? (turn.stats.end ?? start)
            : (timestampOf(next) ?? start);
      const isError = result === undefined ? false : partsOf(result.model).some((part) => part["isError"] === true);
      const kind: Step["kind"] = call === undefined ? "think" : isError ? "error" : "tool";
      steps.push({
        id: entry.id,
        kind,
        label: stepText(entry, call),
        start,
        end: Math.max(end, start),
        entry,
        result,
      });
      const spent = Math.max(0, end - start);
      if (kind === "think") phases.think += spent;
      else if (kind === "error") phases.error += spent;
      else phases.tool += spent;
    }
    const paths = new Set<string>();
    let added = 0;
    let removed = 0;
    let tools = 0;
    let cost = 0;
    let tokens = 0;

    // pi records usage on every assistant message; the turn's spend is their sum.
    for (const entry of [...turn.internals, ...turn.finals]) {
      const messages = Array.isArray(entry.model) ? (entry.model as unknown as Array<Record<string, unknown>>) : [];
      for (const message of messages) {
        const usage = message["usage"] as { cost?: { total?: number }; totalTokens?: number } | undefined;
        cost += usage?.cost?.total ?? 0;
        tokens += usage?.totalTokens ?? 0;
      }
    }

    for (const entry of turn.internals) {
      for (const part of partsOf(entry.model)) {
        if (part["type"] === "toolCall") {
          tools += 1;
          const args = part["arguments"] as Record<string, unknown> | undefined;
          const path = typeof args?.["path"] === "string" ? (args["path"] as string) : undefined;
          if (path !== undefined) paths.add(path);
        }
        if (part["type"] === "text") {
          const stats = diffStats(String(part["text"] ?? ""));
          if (stats !== undefined) {
            added += stats.added;
            removed += stats.removed;
          }
        }
      }
    }

    // Approval time inside this turn: a run that waited on a human should say so.
    const turnStart = timestamps.at(0);
    const turnEnd = timestamps.at(-1);
    if (turnStart !== undefined && turnEnd !== undefined) {
      for (const wait of waits) {
        const overlap = Math.min(turnEnd, wait.end) - Math.max(turnStart, wait.start);
        if (overlap > 0) phases.wait += overlap;
      }
    }

    turn.steps = steps;
    turn.stats = {
      tools,
      files: paths.size,
      added,
      removed,
      cost,
      tokens,
      phases,
      start: timestamps.at(0),
      end: timestamps.at(-1),
      ms: timestamps.length >= 2 ? timestamps[timestamps.length - 1]! - timestamps[0]! : undefined,
    };
  }
  return turns;
}
