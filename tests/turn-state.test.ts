import assert from "node:assert/strict";
import test from "node:test";
import { isLive, runningTool, turnState } from "../client/src/lib/turn-state.ts";

const base = { busy: true, hasAnswer: false, text: "" };

test("between two tool calls the turn is thinking, never nothing", () => {
  assert.deepEqual(turnState(base), { kind: "thinking" });
  assert.equal(isLive(turnState(base)), true);
});

test("a running tool wins over partial text, and keeps both", () => {
  const state = turnState({
    ...base,
    text: "我在看日志",
    tool: { name: "bash", tail: "npm test" },
  });
  assert.deepEqual(state, { kind: "tool", name: "bash", tail: "npm test", text: "我在看日志" });
});

test("text without a tool is streaming", () => {
  assert.deepEqual(turnState({ ...base, text: "答案的前半段" }), { kind: "streaming", text: "答案的前半段" });
});

test("an idle conversation is not live, answered or not", () => {
  assert.deepEqual(turnState({ busy: false, hasAnswer: false, text: "" }), { kind: "idle" });
  assert.deepEqual(turnState({ busy: false, hasAnswer: true, text: "答完了" }), { kind: "settled" });
  assert.equal(isLive(turnState({ busy: false, hasAnswer: false, text: "" })), false);
});

/** A turn that is still running while the previous answer is already on screen. */
test("busy with an answer already delivered is settled, not live", () => {
  assert.deepEqual(turnState({ busy: true, hasAnswer: true, text: "" }), { kind: "settled" });
});

test("the running tool is picked out of the slots, with its last printed line", () => {
  const tools = [
    { name: "read", status: "done", output: "file contents" },
    { name: "bash", status: "running", output: "line one\n\n  \nnpm test\n" },
  ];
  assert.deepEqual(runningTool(tools), { name: "bash", tail: "npm test" });
  assert.equal(runningTool([{ name: "read", status: "done" }]), undefined);
  assert.equal(runningTool(undefined), undefined);
});
