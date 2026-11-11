import { join, dirname } from "node:path";
import { createSqliteTelemetry, type SqliteTelemetry } from "@earendil-works/chord/telemetry-sqlite";
import { openNodeSqliteDatabase } from "@earendil-works/chord/sqlite/node";
import { log, logError } from "./log.ts";

/**
 * Spans for every durable task, model request and tool call, in their own SQLite file beside the
 * agent's storage.
 *
 * Without this, "why did that turn take 11 minutes" could only be answered by reading entry
 * timestamps after the fact. `durable trace` reads the same file read-only, so the cost of a slow
 * turn can be located while the agent keeps running.
 */
export type Telemetry = { flush: () => Promise<void>; close: () => Promise<void> };

export function telemetryPath(dbPath: string): string {
  return join(dirname(dbPath), "telemetry.sqlite");
}

export async function openTelemetry(dbPath: string): Promise<SqliteTelemetry | undefined> {
  const path = telemetryPath(dbPath);
  try {
    const db = await openNodeSqliteDatabase(path);
    const telemetry = await createSqliteTelemetry(db, {});
    log("telemetry", "recording spans", { path });
    return telemetry;
  } catch (error) {
    // Observability must never be the reason the agent does not start.
    logError("telemetry", "could not open the span store; continuing without spans", error);
    return undefined;
  }
}

/** Reads recent traces for the CLI; read-only, so it works while the agent is running. */
export async function readTraces(
  dbPath: string,
  limit: number,
): Promise<Array<{ traceId: string; name: string; startedMs: number; ms: number; spans: number; errors: number }>> {
  const { openTelemetryStore } = await import("@earendil-works/chord/telemetry-sqlite/node");
  const store = await openTelemetryStore(telemetryPath(dbPath));
  try {
    const { traces } = await store.findTraces({ limit });
    return traces.map((trace) => {
      const spans = [...trace.spans];
      const start = Math.min(...spans.map((span) => span.startedMs));
      const end = Math.max(...spans.map((span) => span.endedMs));
      const errors = spans.filter((span) => typeof span.attributes["error"] !== "undefined").length;
      return {
        traceId: trace.traceId,
        name: spans[0]?.name ?? "(empty)",
        startedMs: start,
        ms: end - start,
        spans: spans.length,
        errors,
      };
    });
  } finally {
    await store.close();
  }
}
