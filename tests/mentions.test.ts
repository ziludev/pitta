import assert from "node:assert/strict";
import { test } from "node:test";
import { stripMentionsWith } from "../src/feishu.ts";

/**
 * This cost the owner a working /allow: in a group the message arrives as "@_user_1
 * /allow", the token became "@", and every slash command stopped matching.
 */
const bot = "ou_bot";
const owner = "ou_owner";

test("mentioning the bot leaves no residue before a command", () => {
  const text = stripMentionsWith("@_user_1 /allow", [{ key: "@_user_1", name: "agent", id: { open_id: bot } }], bot);
  assert.equal(text, "/allow");
});

test("asking the bot something reads as a plain sentence", () => {
  const text = stripMentionsWith("@_user_1 帮我看下日志", [{ key: "@_user_1", name: "agent", id: { open_id: bot } }], bot);
  assert.equal(text, "帮我看下日志");
});

test("other people keep their name", () => {
  const text = stripMentionsWith(
    "@_user_1 让 @_user_2 处理",
    [
      { key: "@_user_1", name: "agent", id: { open_id: bot } },
      { key: "@_user_2", name: "张三", id: { open_id: owner } },
    ],
    bot,
  );
  assert.equal(text, "让 @张三 处理");
});

test("without knowing who the bot is, the command still normalises", () => {
  const text = stripMentionsWith("@_user_1 /stop", [{ key: "@_user_1", name: "agent", id: { open_id: bot } }], undefined);
  assert.equal(text, "@agent /stop");
  // handle() drops a leading mention-shaped prefix before matching, so this still works
  assert.equal(text.trim().replace(/^@\S*\s*/, ""), "/stop");
});
