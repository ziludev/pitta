import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import {
  dropAllApprovals,
  dropApproval,
  listApprovals,
  pendingCount,
  registerApproval,
  resolveApproval,
  setWaitRecorder,
} from "../src/approvals.ts";

/**
 * The approval registry is the fail-closed gate in front of dangerous tool calls. Two
 * incidents lived here: a second click reporting "already handled" after a slow card
 * callback, and a wait that belonged to no turn.
 */
async function register(callId: string, approved: (value: boolean) => void, conversationId?: number): Promise<void> {
  registerApproval({
    callId,
    conversationId,
    tool: "bash",
    reason: "删除文件",
    surfaceId: "oc_test",
    summary: "rm -rf /tmp/x",
    resolve: approved,
  });
}

beforeEach(() => {
  for (const entry of listApprovals()) dropApproval(entry.callId);
  setWaitRecorder(undefined);
});

test("a decision reaches the waiting call exactly once", async () => {
  const seen: boolean[] = [];
  await register("call-1", (approved) => seen.push(approved));
  assert.equal(pendingCount(), 1);
  assert.equal(resolveApproval("call-1", true, "test"), true);
  assert.deepEqual(seen, [true]);
  assert.equal(pendingCount(), 0);
});

test("the second click is a no-op instead of a second resolve", async () => {
  const seen: boolean[] = [];
  await register("call-2", (approved) => seen.push(approved));
  assert.equal(resolveApproval("call-2", false, "test"), true);
  assert.equal(resolveApproval("call-2", true, "test"), false);
  assert.deepEqual(seen, [false]);
});

test("resolving an unknown call reports nothing was waiting", () => {
  assert.equal(resolveApproval("missing", true, "test"), false);
});

test("the wait is recorded with its conversation and duration", async () => {
  const waits: Array<{ conversationId?: number; tool: string; start: number; end: number }> = [];
  setWaitRecorder((wait) => waits.push(wait));
  await register("call-3", () => {}, 42);
  resolveApproval("call-3", true, "test");
  assert.equal(waits.length, 1);
  assert.equal(waits[0]?.conversationId, 42);
  assert.equal(waits[0]?.tool, "bash");
  assert.ok((waits[0]?.end ?? 0) >= (waits[0]?.start ?? 0));
});

test("an aborted call drops out without recording a wait", async () => {
  const waits: unknown[] = [];
  setWaitRecorder((wait) => waits.push(wait));
  await register("call-4", () => {}, 7);
  dropApproval("call-4");
  assert.equal(pendingCount(), 0);
  assert.equal(waits.length, 0);
});

/**
 * The registry owns the pending state now. The Feishu surface used to keep its own map and its own
 * timer next to this one, so "still pending" could be true here and false there — and a timeout that
 * the card reported had nothing to do with what the waiting call was told.
 */
test("a timeout denies through the same path, and the surface hears it once", async () => {
  const settled: Array<{ approved: boolean; by: string }> = [];
  const seen: boolean[] = [];
  registerApproval({
    callId: "call-5",
    tool: "bash",
    reason: "删除文件",
    surfaceId: "oc_test",
    summary: "rm -rf /tmp/x",
    timeoutMs: 20,
    onSettled: (outcome) => settled.push(outcome),
    resolve: (approved) => seen.push(approved),
  });
  await new Promise((done) => setTimeout(done, 60));
  assert.deepEqual(settled, [{ approved: false, by: "timeout" }]);
  assert.deepEqual(seen, [false]);
  assert.equal(pendingCount(), 0);
});

test("a request answered before its timeout leaves no timer behind", async () => {
  const settled: Array<{ approved: boolean; by: string }> = [];
  registerApproval({
    callId: "call-6",
    tool: "bash",
    reason: "删除文件",
    surfaceId: "oc_test",
    summary: "rm -rf /tmp/x",
    timeoutMs: 20,
    onSettled: (outcome) => settled.push(outcome),
    resolve: () => {},
  });
  assert.equal(resolveApproval("call-6", true, "client"), true);
  await new Promise((done) => setTimeout(done, 60));
  assert.deepEqual(settled, [{ approved: true, by: "client" }]);
  assert.equal(pendingCount(), 0);
});

test("shutdown unblocks every waiter without patching a surface", async () => {
  const settled: unknown[] = [];
  const seen: boolean[] = [];
  registerApproval({
    callId: "call-7",
    tool: "bash",
    reason: "删除文件",
    surfaceId: "oc_test",
    summary: "rm -rf /tmp/x",
    onSettled: (outcome) => settled.push(outcome),
    resolve: (approved) => seen.push(approved),
  });
  assert.equal(dropAllApprovals(), 1);
  assert.deepEqual(seen, [false]);
  assert.deepEqual(settled, []);
  assert.equal(pendingCount(), 0);
});
