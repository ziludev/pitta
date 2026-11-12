import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteBlock, quoteText, quotedParentId } from "../src/feishu.ts";

/**
 * A reply in Feishu carries the id of the message it answers, never its text, so "这个怎么改"
 * reached the model with nothing to point at. The quote is read back by id and put in front of
 * the reply; these are the parts that decide what the model actually sees.
 */

test("a quoted text message keeps its words and names other people's mentions", () => {
  const content = JSON.stringify({ text: "@_user_1 这个报错怎么修" });
  const mentions = [{ key: "@_user_1", name: "小王", id: { open_id: "ou_x" } }];
  assert.equal(quoteText("text", content, mentions), "@小王 这个报错怎么修");
});

test("a quoted message of another kind says what it was", () => {
  assert.equal(quoteText("image", JSON.stringify({ image_key: "img_v2_x" })), "（一张图片）");
  assert.equal(quoteText("audio", JSON.stringify({ file_key: "file_x" })), "（一条语音）");
  assert.equal(quoteText("file", JSON.stringify({ file_key: "file_x" })), "（一个文件）");
  assert.equal(quoteText("sticker", "{}"), "（一个表情）");
});

test("a quoted rich-text post keeps the words and counts its pictures", () => {
  const content = JSON.stringify({
    content: [
      [
        { tag: "text", text: "截图在这里 " },
        { tag: "img", image_key: "img_1" },
      ],
    ],
  });
  assert.equal(quoteText("post", content), "截图在这里");
  const picturesOnly = JSON.stringify({ content: [[{ tag: "img", image_key: "img_1" }]] });
  assert.equal(quoteText("post", picturesOnly), "（1 张图片）");
});

test("a quote that cannot be parsed still tells the model it was something", () => {
  assert.equal(quoteText("text", "not json"), "（没有可读的文字）");
});

test("the block marks where the quote starts and ends", () => {
  const block = quoteBlock({ who: "ou_9d6f1a", text: "原文一行" });
  assert.equal(block, "[引用 · ou_9d6f1a 的消息]\n原文一行\n[引用结束]\n\n");
});

/**
 * Feishu sets parent_id to the topic's root on every message inside a topic, which is not a quote:
 * 44 of the 46 topic messages in this agent's log had parent == root. Reading it would paste the
 * topic's first message in front of every turn.
 */
test("a topic message is not a quote unless it points at something else", () => {
  // A plain message in a topic: parent is the root, nothing was quoted.
  assert.equal(quotedParentId({ parent_id: "om_root", root_id: "om_root", thread_id: "omt_1" }), "");
  // A real quote inside a topic.
  assert.equal(quotedParentId({ parent_id: "om_other", root_id: "om_root", thread_id: "omt_1" }), "om_other");
  // A plain reply outside a topic: parent == root is still the message being answered.
  assert.equal(quotedParentId({ parent_id: "om_asked", root_id: "om_asked" }), "om_asked");
  // Nothing to read.
  assert.equal(quotedParentId({}), "");
  assert.equal(quotedParentId({ parent_id: "om_self", message_id: "om_self" }), "");
});

test("a merged chat record says what it is and that its messages are unreadable", () => {
  const quoted = quoteText("merge_forward", JSON.stringify({ title: "张浩与刘普昌的会话记录" }));
  assert.match(quoted, /合并转发的聊天记录：张浩与刘普昌的会话记录/);
  assert.match(quoted, /读不到/);
});

test("a quoted card keeps the words inside it", () => {
  const card = JSON.stringify({
    title: "上线通知",
    elements: [[{ tag: "text", text: "example-service 已部署到测试环境" }]],
  });
  assert.equal(quoteText("interactive", card), "上线通知 example-service 已部署到测试环境");
});
