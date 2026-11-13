import assert from "node:assert/strict";
import { test } from "node:test";

import { levelOf, type ChatLevel } from "../src/access.ts";
import { rejectionReason, type Gate } from "../src/feishu.ts";

/**
 * One level per chat decides who gets an answer: `closed` answers nobody, `owner` answers only
 * the owner, `group` answers everyone (as a guest unless it is the owner). Before, the same
 * question was answered by two allowlists and a derived rule, and the first version let an
 * authorized group card every member separately.
 */
const policy: Gate = { mentionsOnly: true };

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
const group = (chat: string, sender: string) =>
  event(chat, sender, { chatType: "group", mentions: [{ key: "@_user_1" }] });

test("a chat nobody opened answers nobody, even the owner", () => {
  assert.equal(rejectionReason(event("oc_new", "ou_owner"), parsed, "closed", true, policy), "chat-not-allowed");
  assert.equal(rejectionReason(event("oc_new", "ou_stranger"), parsed, "closed", false, policy), "chat-not-allowed");
});

test("a chat pinned to the owner answers only the owner", () => {
  assert.equal(rejectionReason(event("oc_owner", "ou_owner"), parsed, "owner", true, policy), undefined);
  assert.equal(rejectionReason(group("oc_owner", "ou_colleague"), parsed, "owner", false, policy), "owner-only");
});

test("an opened group answers every member, no per-person authorization", () => {
  assert.equal(rejectionReason(group("oc_group", "ou_colleague"), parsed, "group", false, policy), undefined);
  assert.equal(rejectionReason(group("oc_group", "ou_owner"), parsed, "group", true, policy), undefined);
  assert.equal(rejectionReason(event("oc_group", "ou_colleague"), parsed, "group", false, policy), undefined);
});

test("a guest group still requires the @", () => {
  const without = event("oc_group", "ou_colleague", { chatType: "group" });
  assert.equal(rejectionReason(without, parsed, "group", false, policy), "group-message-without-mention");
});

test("empty content and unsupported types are named separately", () => {
  const empty = { text: "", imageKeys: [] } as never;
  assert.equal(rejectionReason(event("oc_owner", "ou_owner"), empty, "owner", true, policy), "empty-content");
  const voice = event("oc_owner", "ou_owner");
  (voice as { message: { message_type: string } }).message.message_type = "sticker";
  assert.match(rejectionReason(voice, parsed, "owner", true, policy) ?? "", /unsupported-message-type/);
});

test("levelOf: a stored level wins, `.env` is the fallback, everything else is closed", () => {
  const access: Record<string, ChatLevel> = { oc_group: "group", oc_pinned: "owner" };
  assert.equal(levelOf("oc_group", access, ["oc_env"]), "group");
  assert.equal(levelOf("oc_pinned", access, ["oc_env"]), "owner");
  assert.equal(levelOf("oc_env", access, ["oc_env"]), "owner");
  assert.equal(levelOf("oc_unknown", access, ["oc_env"]), "closed");
  // `.env` must not win over an explicit level: a group opened with /allow stays a group.
  assert.equal(levelOf("oc_env", { ...access, oc_env: "group" }, ["oc_env"]), "group");
});

// alex asking in his own group is still the owner: /allow opened the group to other people, it did
// not demote him. Memory stays off for the conversation either way.
test("a shared group tells alex he may change files, and a guest that he may not", async () => {
  const { groupInstructions } = await import("../src/feishu.ts");
  const { config } = await import("../src/config.ts");
  const owner = groupInstructions("owner");
  const guest = groupInstructions("guest");

  assert.match(owner, /改文件/);
  assert.doesNotMatch(owner, /只读（read/);
  assert.match(owner, /旧规则已作废/, "the earlier read-only answer has to be superseded explicitly");
  assert.match(guest, /只读/);
  assert.doesNotMatch(guest, /按他说的改文件/);
  assert.doesNotMatch(guest, /旧规则已作废/);
  for (const text of [owner, guest]) {
    assert.match(text, new RegExp(`不要透露 ${config.feishu.ownerName}`), "memory rule is the same for both");
  }
  assert.match(groupInstructions("guest", "只回答本群主题"), /只回答本群主题/, "/open keeps its topic rule");
  assert.match(groupInstructions("owner"), /方括号是网关标注的说话人/, "the bracket convention is explained");
});

// The model does not trust an identity claim in the instructions; it reads the speaker on the
// message. Verified against the real model: a guest turn refused and left the file alone, then
// an owner turn in the same conversation changed it.
test("each group message carries who is speaking", async () => {
  const { speakerTag } = await import("../src/feishu.ts");
  const owner = "ou_0123456789abcdef0123456789abcdef";
  const { config } = await import("../src/config.ts");
  assert.match(speakerTag(true, owner), new RegExp(`^\\[${config.feishu.ownerName} 本人\\]$`));
  // A name, when Feishu gives one, replaces the id fragment; without one the id still identifies.
  assert.equal(speakerTag(false, "ou_9abc1a2b3c4d", "张三"), "[群成员 张三]");
  assert.match(speakerTag(false, "ou_9abc1a2b3c4d"), /^\[群成员 ou_9abc1\]/);
  assert.match(speakerTag(false, "ou_9abc1a2b3c4d", ""), /^\[群成员 ou_9abc1\]/);
  assert.doesNotMatch(speakerTag(false, "ou_9abc1a2b3c4d", "张三"), /本人|ou_9abc1/);
});

// What the model actually said in the group, and what must not be mistaken for a refusal.
test("a read-only refusal is recognised, a normal answer is not", async () => {
  const { looksLikeReadOnlyRefusal } = await import("../src/feishu.ts");
  const refusals = [
    "这轮我在这个共享群里是只读的（不改工作区文件、不推分支），所以没法直接写进去。",
    "这个群在会话初始化时就把写权限关闭了，并非我不愿意执行；即便你本人要求，我这轮也只能只读。",
    "还是不能改：这个群会话被设成只读，我不能改文件，即使是你本人在这里发也一样。",
    "当前这个群会话的权限被固定为只读，写文件会被拦截，我没法绕过。",
    "bash 在这个群仍然被拦着，因为群是 guest 模式，我无法执行命令。",
    "你可以这样做：把下面这段粘贴到终端运行。",
  ];
  for (const text of refusals) assert.equal(looksLikeReadOnlyRefusal(text), true, text.slice(0, 30));

  const answers = [
    "改好了：a.txt 里的 foo 已经换成 bar。",
    "已经改完并提交：commit 4f2a1c，MR 链接贴在下面。",
    "worker 日志不再报 missing required param businessId，重提一次后 user_license_verify 变成 VERIFIED。",
    // A real approval card is not a false refusal: the tool really is waiting for a human.
    "rm -rf 这条被拦下来等你确认了，允许后我继续。",
  ];
  for (const text of answers) assert.equal(looksLikeReadOnlyRefusal(text), false, text.slice(0, 30));
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
