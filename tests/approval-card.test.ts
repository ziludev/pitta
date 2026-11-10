import assert from "node:assert/strict";
import { test } from "node:test";
import { approvalCard } from "../src/feishu.ts";
import { approvalReason } from "../src/approval.ts";

/**
 * The card is the only way to answer from Feishu, so a wrong button payload is silent:
 * the click lands, nothing happens. These assert the shapes the handler reads.
 */
const request = {
  callId: "call-1",
  conversationId: 7,
  tool: "bash",
  summary: "rm -rf /tmp/x",
  reason: "删除文件：rm -rf /tmp/x",
  surfaceId: "oc_test",
};

type Button = { text: { content: string }; value: Record<string, unknown> };

function buttonsOf(card: Record<string, unknown>): Button[] {
  const elements = card["elements"] as Array<{ tag: string; actions?: Button[] }>;
  return elements.find((element) => element.tag === "action")?.actions ?? [];
}

test("a grantable call offers the conversation-wide answer", () => {
  const buttons = buttonsOf(approvalCard({ ...request, grantKey: "rm" }));
  const labels = buttons.map((button) => button.text.content);
  assert.deepEqual(labels, ["允许", "本会话内全部允许", "拒绝"]);
  const session = buttons.find((button) => button.text.content === "本会话内全部允许");
  assert.equal(session?.value["approval"], "call-1");
  assert.equal(session?.value["ok"], true);
  assert.equal(session?.value["session"], true);
  assert.equal(session?.value["key"], "rm");
});

test("a call with no grantable class keeps the two buttons", () => {
  const labels = buttonsOf(approvalCard(request)).map((button) => button.text.content);
  assert.deepEqual(labels, ["允许", "拒绝"]);
});

test("risk classes are stable strings the grant can key on", () => {
  assert.deepEqual(approvalReason("bash", { command: "rm -rf /tmp/x" }), { reason: "删除文件：rm -rf /tmp/x", key: "rm" });
  assert.equal(approvalReason("bash", { command: "git push --force" })?.key, "force-push");
  assert.equal(approvalReason("bash", { command: "ls -la" }), undefined);
  // A write outside the workspace is its own class; inside it needs no approval at all.
  const outside = approvalReason("write", { path: "/Users/someone/else/repo/a.ts" });
  assert.equal(outside?.key, "write-outside");
});
