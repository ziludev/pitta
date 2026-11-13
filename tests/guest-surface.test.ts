import assert from "node:assert/strict";
import { test } from "node:test";
import { guestBlockReason, guestShellBlockReason, outsideRoots } from "../src/approval.ts";
import { isOwnerOperator } from "../src/feishu.ts";

const WS = "/Users/example/learn/pi-durable-agent/workspace";
const PROJECT = "/Users/example/work/example-service";

/**
 * The guest surface is the part that has to hold when the prompt does not: a group member is
 * told "read only" in words, and the shell was still one tool call away. These are the calls
 * that used to go through.
 */

const blocked = (tool: string, args: Record<string, unknown> = {}, roots: readonly string[] = [WS]) =>
  guestBlockReason(tool, args, roots) !== undefined;

test("a guest cannot write, or borrow the owner's identity", () => {
  for (const tool of ["write", "edit", "feishu_agenda", "feishu_doc_read", "feishu_create_task", "delegate", "delegate_parallel", "build_feature", "mcp__jira__create_issue"]) {
    assert.equal(blocked(tool, { command: "ls", path: "a.ts", content: "x" }), true, tool);
  }
});

test("a guest shell is open to reading and closed to changing", () => {
  const allowed = [
    "ls -la",
    "git log --oneline -20",
    "git -C /Users/example/work/example-service show HEAD:src/main.ts",
    "grep -rn \"OrderTotal\" /Users/example/work/example-service/src",
    "rg minUrl | head -20",
    "psql -h 10.0.0.10 -c \"select user_id from userinfo limit 5\"",
    "curl -sI https://cdn.example.com/cai/dh_avatar/x.jpeg",
    "dig +short example.com",
  ];
  for (const command of allowed) assert.equal(guestShellBlockReason(command, [WS, PROJECT]), undefined, command);

  const refused = [
    "rm -rf build",
    "git push origin main",
    "git checkout -b x",
    "git log --output=/tmp/x",
    "echo hi > /tmp/out",
    "cat a.txt | tee b.txt",
    "psql -c \"update userinfo set avatar = null\"",
    "psql -c \"select 1\" && psql -c \"delete from t\"",
    "curl -X POST https://x/y",
    "curl -o /tmp/a https://x/y",
    "sudo ls",
    "find . -name x -delete",
    "python3 -c \"print(1)\"",
    "node -e 1",
    "cat /Users/example/work/example-service/.env",
    "awk '{system(\"id\")}' a.txt",
    "sed -i s/a/b/ f.txt",
    "cat $(echo /etc/passwd)",
  ];
  for (const command of refused) assert.notEqual(guestShellBlockReason(command, [WS, PROJECT]), undefined, command);
});

test("a guest reads any registered project, not just the linked one", () => {
  assert.equal(blocked("read", { path: "/Users/example/work/example-service/src/a.java" }, [WS, PROJECT]), false);
  assert.equal(blocked("read", { path: "/Users/example/work/example-service/.env" }, [WS, PROJECT]), true);
  assert.equal(blocked("project_search", { pattern: "minUrl", path: "../etc" }, [WS, PROJECT]), true);
});

test("a guest can read project code, search the group's memory, read a skill, set a reminder", () => {
  assert.equal(blocked("read", { path: "src/feishu.ts" }), false);
  assert.equal(blocked("read", { path: "workspace/notes.md" }), false);
  assert.equal(blocked("skill", { name: "lark-doc" }), false);
  assert.equal(blocked("recall", { query: "本群代号" }), false);
  assert.equal(blocked("remind", { text: "喝水", in_minutes: 30 }), false);
  // The read-only pair that replaced "just allow bash": search the project, query the logs.
  assert.equal(blocked("project_search", { pattern: "license" }), false);
  assert.equal(blocked("logs_query", { query: '"2100083235"' }), false);
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

// A question about a real project has to read that project: the chat's own repo is a second
// root, and the secrets rule still applies inside it.
test("a guest reads the project the chat is about, but not a different one", () => {
  const roots = [WS, PROJECT];
  assert.equal(blocked("read", { path: `${PROJECT}/user-service/src/Main.java` }, roots), false);
  assert.equal(blocked("read", { path: `${PROJECT}/.worktrees/conv-67/src/Main.java` }, roots), false);
  assert.equal(blocked("read", { path: `${PROJECT}/.env` }, roots), true, "secrets stay denied inside the project");
  assert.equal(blocked("read", { path: "/Users/example/work/other-repo/src/a.ts" }, roots), true);
  assert.equal(blocked("read", { path: "/Users/example/work/example-service-secrets/a.ts" }, roots), true, "a prefix is not a root");
  assert.equal(outsideRoots(PROJECT, roots), false);
  assert.equal(outsideRoots(`${"../"}example-service`, [WS]), true);
});

test("an approval click counts only for a configured owner", () => {
  assert.equal(isOwnerOperator("ou_me", ["ou_me"]), true);
  assert.equal(isOwnerOperator("ou_someone", ["ou_me"]), false);
  // An empty allowlist is a misconfiguration, never "everyone wins".
  assert.equal(isOwnerOperator("ou_me", []), false);
  assert.equal(isOwnerOperator("", ["ou_me"]), false);
});
