import assert from "node:assert/strict";
import { test } from "node:test";
import { formatEvent, pushEvent, type AuditEvent } from "../src/audit.ts";

/**
 * The audit ring answers "who looked at what, and who let them" without growing. Only decisions
 * are recorded, so the list stays short enough to read; the ring bounds it anyway.
 */

function event(kind: AuditEvent["kind"], detail: string, at = 1_000): AuditEvent {
  return { at, kind, detail };
}

test("events append in order", () => {
  const kept = pushEvent([], event("access", "first"));
  assert.equal(kept.length, 1);
  assert.equal(kept[0]?.detail, "first");
});

test("the oldest event falls off when the ring is full", () => {
  let events: AuditEvent[] = [];
  for (let index = 0; index < 5; index += 1) events = pushEvent(events, event("deny", `e${index}`, index), 3);
  assert.deepEqual(
    events.map((entry) => entry.detail),
    ["e2", "e3", "e4"],
  );
});

test("a line carries the fields a person would ask for", () => {
  const line = formatEvent({
    at: Date.UTC(2026, 10, 11, 9, 30),
    kind: "query",
    who: "abcde",
    chat: "oc_0123456789abcdef0123456789abcdef",
    level: "group",
    tool: "logs_query",
    detail: "env=dev logstore=app-dev-stdout 15m error",
  });
  const fields = line.split("\t");
  assert.equal(fields[1], "query");
  assert.equal(fields[2], "abcde");
  assert.equal(fields[3], "89abcdef");
  assert.equal(fields[4], "group");
  assert.equal(fields[5], "logs_query");
  assert.match(fields[6] ?? "", /env=dev/);
});
