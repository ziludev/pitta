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

test("a p2p chat authorized from Feishu still needs an authorized sender", () => {
  const gate = rejectionReason(event("oc_colleague", "ou_colleague"), parsed, ["oc_colleague"], [], [], policy);
  assert.equal(gate, "sender-not-allowed");
});

// Authorizing a group is authorizing the people in it: /allow opens it as a guest chat, so a
// new member needs no per-person card. A group listed only in .env keeps the sender gate,
// because there the allowlist is the owner's explicit rule rather than a default.
test("a group authorized from Feishu is a guest chat, so no sender gate", () => {
  const group = event("oc_colleague", "ou_colleague", { chatType: "group", mentions: [{ key: "@_user_1" }] });
  assert.equal(rejectionReason(group, parsed, ["oc_colleague"], [], [], policy), undefined);
});

test("a group listed in .env still needs an authorized sender", () => {
  const strict: Gate = { allowedChatIds: ["oc_group"], allowedSenderIds: ["ou_owner"], mentionsOnly: true };
  const group = event("oc_group", "ou_colleague", { chatType: "group", mentions: [{ key: "@_user_1" }] });
  assert.equal(rejectionReason(group, parsed, [], [], [], strict), "sender-not-allowed");
});

test("a guest group still requires the @", () => {
  const group = event("oc_colleague", "ou_colleague", { chatType: "group" });
  assert.equal(rejectionReason(group, parsed, ["oc_colleague"], [], [], policy), "group-message-without-mention");
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

// The owner asking in his own group is still the owner: /allow opened the group to other
// people, it did not demote him. Memory stays off for the conversation either way.
test("a shared group tells the owner he may change files, and a guest that he may not", async () => {
  const { groupInstructions } = await import("../src/feishu.ts");
  const owner = groupInstructions("owner");
  const guest = groupInstructions("guest");

  assert.match(owner, /改文件/);
  assert.doesNotMatch(owner, /只读（read/);
  assert.match(owner, /旧规则已作废/, "the earlier read-only answer has to be superseded explicitly");
  assert.match(guest, /只读/);
  assert.doesNotMatch(guest, /按他说的改文件/);
  assert.doesNotMatch(guest, /旧规则已作废/);
  for (const text of [owner, guest]) assert.match(text, /不要透露主人/, "memory rule is the same for both");
  assert.match(groupInstructions("guest", "只回答本群主题"), /只回答本群主题/, "/open keeps its topic rule");
  assert.match(groupInstructions("owner"), /方括号是网关标注的说话人/, "the bracket convention is explained");
});

// The model does not trust an identity claim in the instructions; it reads the speaker on the
// message. Verified against the real model: a guest turn refused and left the file alone, then
// an owner turn in the same conversation changed it.
test("each group message carries who is speaking", async () => {
  const { speakerTag } = await import("../src/feishu.ts");
  const owner = "ou_0123456789abcdef0123456789abcdef";
  assert.match(speakerTag(true, owner), /^\[主人本人 ou_abcde\]/);
  assert.match(speakerTag(false, "ou_9d6f1a2b3c4d"), /^\[群成员 ou_9d6f1\]/);
  assert.doesNotMatch(speakerTag(false, "ou_9d6f1a2b3c4d"), /主人/);
});

// Threading rule, which has flip-flopped: an @ in a group is one person's question, so
// the answer goes into a topic instead of pushing the timeline aside for everyone.
test("an @ in a group answers in a topic, a plain message answers inline", async () => {
  const { wantsThread } = await import("../src/feishu.ts");
  const messageOf = (value: unknown) => (value as { message: never }).message;

  const mentioned = event("oc_owner", "ou_owner", { chatType: "group", mentions: [{ key: "@_user_1" }] });
  assert.equal(wantsThread(messageOf(mentioned)), true, "mention should thread");

  const plain = event("oc_owner", "ou_owner", { chatType: "group" });
  assert.equal(wantsThread(messageOf(plain)), false, "no mention, no thread");

  const inThread = event("oc_owner", "ou_owner", { chatType: "group" });
  (inThread as { message: { thread_id: string } }).message.thread_id = "omt_1";
  assert.equal(wantsThread(messageOf(inThread)), true, "already in a topic");

  const direct = event("oc_owner", "ou_owner", { chatType: "p2p", mentions: [{ key: "@_user_1" }] });
  assert.equal(wantsThread(messageOf(direct)), false, "p2p never threads");
});
