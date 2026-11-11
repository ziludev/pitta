import assert from "node:assert/strict";
import { test } from "node:test";
import { guestBlockReason } from "../src/approval.ts";
import { isOwnerOperator } from "../src/feishu.ts";

/**
 * The guest surface is the part that has to hold when the prompt does not: a group member is
 * told "read only" in words, and the shell was still one tool call away. These are the calls
 * that used to go through.
 */

const blocked = (tool: string, args: Record<string, unknown> = {}) => guestBlockReason(tool, args) !== undefined;

test("a guest cannot run a shell, write, or borrow the owner's identity", () => {
  for (const tool of ["bash", "write", "edit", "feishu_agenda", "feishu_doc_read", "feishu_create_task", "delegate", "delegate_parallel", "build_feature", "mcp__jira__create_issue"]) {
    assert.equal(blocked(tool, { command: "ls", path: "a.ts", content: "x" }), true, tool);
  }
});

test("a guest can read project code, search the group's memory, read a skill, set a reminder", () => {
  assert.equal(blocked("read", { path: "src/feishu.ts" }), false);
  assert.equal(blocked("read", { path: "workspace/notes.md" }), false);
  assert.equal(blocked("skill", { name: "lark-doc" }), false);
  assert.equal(blocked("recall", { query: "本群代号" }), false);
  assert.equal(blocked("remind", { text: "喝水", in_minutes: 30 }), false);
});

test("a guest read cannot reach secrets, or anything outside the workspace", () => {
  for (const path of [
    ".env",
    "workspace/.env.local",
    ".data/agent.sqlite",
    "~/.ssh/id_rsa",
    ".ssh/id_ed25519",
    "/etc/passwd",
    "../other-project/src/a.ts",
    "config/secret.json",
    "certs/server.pem",
    ".git/config",
  ]) {
    assert.equal(blocked("read", { path }), true, path);
  }
});

test("an approval click counts only for a configured owner", () => {
  assert.equal(isOwnerOperator("ou_me", ["ou_me"]), true);
  assert.equal(isOwnerOperator("ou_someone", ["ou_me"]), false);
  // An empty allowlist is a misconfiguration, never "everyone wins".
  assert.equal(isOwnerOperator("ou_me", []), false);
  assert.equal(isOwnerOperator("", ["ou_me"]), false);
});
