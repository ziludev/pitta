import assert from "node:assert/strict";
import { test } from "node:test";
import { rejectionReason, type Gate } from "../src/feishu.ts";

/**
 * The gate that dropped a colleague's DM twice: first because their chat id was unknown,
 * then because only the owner was an allowed sender. Both had to be authorized from a
 * card, so the two allowlists are exercised separately here.
 */
const policy: Gate = {
  allowedChatIds: ["oc_owner"],
  allowedSenderIds: ["ou_owner"],
  mentionsOnly: true,
};

function event(chat: string, sender: string, options: { chatType?: string; mentions?: unknown[] } = {}) {
  return {
    sender: { sender_id: { open_id: sender } },
    message: {
      message_id: "om_1",
      chat_id: chat,
      chat_type: options.chatType ?? "p2p",
      message_type: "text",
      content: JSON.stringify({ text: "在吗" }),
      mentions: options.mentions,
    },
  } as never;
}

const parsed = { text: "在吗", imageKeys: [], audioKey: undefined } as never;

test("an unknown p2p chat is rejected even when the sender is the owner", () => {
  assert.equal(rejectionReason(event("oc_new", "ou_owner"), parsed, [], [], [], policy), "chat-not-allowed");
});

test("a chat authorized from Feishu still needs an authorized sender", () => {
  const gate = rejectionReason(event("oc_colleague", "ou_colleague"), parsed, ["oc_colleague"], [], [], policy);
  assert.equal(gate, "sender-not-allowed");
});

test("authorizing the sender opens the gate", () => {
  const gate = rejectionReason(
    event("oc_colleague", "ou_colleague"),
    parsed,
    ["oc_colleague"],
    [],
    ["ou_colleague"],
    policy,
  );
  assert.equal(gate, undefined);
});

test("a guest chat is not gated by sender", () => {
  const gate = rejectionReason(event("oc_guest", "ou_anyone"), parsed, ["oc_guest"], ["oc_guest"], [], policy);
  assert.equal(gate, undefined);
});

test("mentions-only still requires an @ in groups", () => {
  const without = event("oc_owner", "ou_owner", { chatType: "group" });
  assert.equal(rejectionReason(without, parsed, [], [], [], policy), "group-message-without-mention");
  const withMention = event("oc_owner", "ou_owner", { chatType: "group", mentions: [{ key: "@_user_1" }] });
  assert.equal(rejectionReason(withMention, parsed, [], [], [], policy), undefined);
});

test("empty content and unsupported types are named separately", () => {
  const empty = { text: "", imageKeys: [] } as never;
  assert.equal(rejectionReason(event("oc_owner", "ou_owner"), empty, [], [], [], policy), "empty-content");
  const voice = event("oc_owner", "ou_owner");
  (voice as { message: { message_type: string } }).message.message_type = "sticker";
  assert.match(rejectionReason(voice, parsed, [], [], [], policy) ?? "", /unsupported-message-type/);
});
