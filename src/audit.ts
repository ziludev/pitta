import { defineDoc, type Harness, type Tx } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import type { ChatLevel } from "./access.ts";

/**
 * Why a permission decision was made, kept where it can be read back instead of only grepped.
 *
 * Only decisions are recorded, not every allowed read: denials, level changes, approvals and
 * the two read-only queries are rare enough that a bounded ring answers "what did a colleague
 * look at, and who let them" without growing without limit.
 */
export type AuditKind = "access" | "deny" | "approve" | "query" | "report";

export type AuditEvent = {
  at: number;
  kind: AuditKind;
  /** Who did it: an open_id suffix for a person, "owner" for the owner's own turn. */
  who?: string;
  chat?: string;
  level?: ChatLevel;
  tool?: string;
  detail?: string;
};

/** The newest events win; older ones fall off the front. */
export const AUDIT_LIMIT = 300;

export const AuditDoc = defineDoc<{ events: AuditEvent[] }>({
  kind: "app.audit",
  version: 1,
  scope: "session",
  initial: () => ({ events: [] }),
  checkpointWhen: () => false,
});

/** Pure so the ring behaviour is testable without a runtime. */
export function pushEvent(events: readonly AuditEvent[], event: AuditEvent, limit = AUDIT_LIMIT): AuditEvent[] {
  const next = [...events, event];
  return next.length <= limit ? next : next.slice(next.length - limit);
}

/** Anything that can write a session doc: the harness, or a tool's own api. */
export type DocWriter = { commit: (body: (tx: Tx) => Promise<void>, context: Context) => Promise<unknown> };

export async function record(writer: DocWriter, context: Context, event: Omit<AuditEvent, "at">): Promise<void> {
  await writer
    .commit(async (tx) => {
      const doc = await tx.doc(AuditDoc);
      doc.events = pushEvent(doc.events, { ...event, at: Date.now() });
    }, context)
    .catch(() => {
      // An audit write must never fail the thing it is recording.
    });
}

export async function recent(harness: Harness, context: Context, limit = 30): Promise<AuditEvent[]> {
  const doc = await harness.snapshot(AuditDoc, context).catch(() => undefined);
  const events = doc?.events ?? [];
  return events.slice(Math.max(0, events.length - limit));
}

/** One line per event, for a terminal. */
export function formatEvent(event: AuditEvent): string {
  const when = new Date(event.at).toLocaleString("sv-SE", { timeZone: "Asia/Shanghai" });
  const who = event.who ?? "-";
  const chat = event.chat === undefined ? "-" : event.chat.slice(-8);
  const level = event.level ?? "-";
  const tool = event.tool ?? "-";
  return [when, event.kind, who, chat, level, tool, event.detail ?? ""].join("\t");
}
