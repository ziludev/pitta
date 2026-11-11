import assert from "node:assert/strict";
import { test } from "node:test";
import { quoteBlock, quoteText } from "../src/feishu.ts";

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
