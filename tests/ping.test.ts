import assert from "node:assert/strict";
import { test } from "node:test";
import { pingSummary } from "../src/feishu.ts";

/**
 * The "答完了" ping is a notification. It used to be the answer's first sixty characters, which
 * shipped `##` headings and `**bold**` markers into the lock screen and cut mid-word.
 */

test("markup does not reach the notification", () => {
  assert.equal(pingSummary("两侧都完成并推送了。总结： ## 交付（全是我手写的） **example**"), "两侧都完成并推送了。");
  assert.equal(pingSummary("## 交付\n\n- 改完了 `greet.js`"), "改完了 greet.js");
});

test("a code block contributes nothing", () => {
  assert.equal(pingSummary("改好了。\n\n```js\nconsole.log(1)\n```"), "改好了。");
});

test("a link keeps its label", () => {
  assert.equal(pingSummary("看这个 [设计文档](https://x.y/z) 就行。"), "看这个 设计文档 就行。");
});

test("a long first sentence is cut cleanly, not mid-punctuation", () => {
  const line = pingSummary(
    "这一轮我把两侧的改动都完成并且推送了，顺带补了四条单测，还有一个遗留项需要你确认一下 DDL 工单之后再决定要不要合到 release 分支上去",
  );
  assert.ok(line.length <= 61, line);
  assert.ok(line.endsWith("…"), line);
  assert.doesNotMatch(line, /[，、,;；:：]\s*…$/, "no dangling punctuation before the ellipsis");
});

test("an empty answer says nothing rather than a bare ellipsis", () => {
  assert.equal(pingSummary(""), "");
  assert.equal(pingSummary("   \n\n"), "");
});
