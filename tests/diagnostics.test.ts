import assert from "node:assert/strict";
import { test } from "node:test";
import { parseLogsQuery, searchRoot } from "../src/diagnostics.ts";

/**
 * The two read-only tools exist so a colleague can search the code and look at logs without a
 * shell. Their limits have to hold on the arguments, since the blast radius is the tool.
 */

const WS = "/Users/example/learn/pi-durable-agent/workspace";
const PROJECT = "/Users/example/work/example-service";

test("logs_query fills in sane defaults", () => {
  const parsed = parseLogsQuery({ query: '"2100083235"' });
  assert.deepEqual(parsed, { env: "dev", logstore: "app-dev-stdout", query: '"2100083235"', minutes: 60, limit: 50 });
});

test("logs_query clamps the window and the row count", () => {
  const wide = parseLogsQuery({ query: "level: ERROR", minutes: 99_999, limit: 9_999 });
  assert.equal(typeof wide, "object");
  assert.equal((wide as { minutes: number }).minutes, 1440);
  assert.equal((wide as { limit: number }).limit, 200);
  const zero = parseLogsQuery({ query: "x", minutes: 0, limit: 0 });
  assert.equal((zero as { minutes: number }).minutes, 60);
});

test("logs_query refuses a bad environment, a suspicious logstore, and an empty query", () => {
  assert.match(String(parseLogsQuery({ query: "x", env: "staging" })), /dev 或 prod/);
  for (const logstore of ["../etc/passwd", "Dora-Dev-Stdout", "a", "app dev stdout'", "app;rm"]) {
    assert.match(String(parseLogsQuery({ query: "x", logstore })), /不合法/, logstore);
  }
  assert.match(String(parseLogsQuery({ query: "   " })), /不能为空/);
  assert.match(String(parseLogsQuery({ query: "x".repeat(501) })), /太长/);
});

test("project_search stays inside the chat's own project", () => {
  const roots = [WS, PROJECT];
  assert.deepEqual(searchRoot({}, roots), { ok: true, path: WS });
  assert.deepEqual(searchRoot({ path: "user-service/src" }, roots), { ok: true, path: `${WS}/user-service/src` });
  assert.equal(searchRoot({ path: `${PROJECT}/user-service/src` }, roots).ok, true);
  assert.equal(searchRoot({ path: "/Users/example/work/other-repo" }, roots).ok, false);
  assert.equal(searchRoot({ path: "/etc" }, roots).ok, false);
  // A sibling whose name starts the same is not inside the project.
  assert.equal(searchRoot({ path: "/Users/example/work/example-service-secrets" }, roots).ok, false);
  assert.equal(searchRoot({ path: "../../../etc" }, roots).ok, false);
});
