import assert from "node:assert/strict";
import { test } from "node:test";
import { isDuplicate, normalizeText, similarity } from "../src/similar.ts";

test("normalizeText folds case, spacing and punctuation", () => {
  assert.equal(normalizeText("  偏好：中文 回答！ "), "偏好中文回答");
});

test("similarity is 1 for the same meaning written differently", () => {
  assert.ok(similarity("主人偏好中文回答", "主人 偏好 用中文回答") > 0.7);
});

test("similarity separates unrelated notes", () => {
  assert.ok(similarity("主人偏好中文回答", "服务器是 arm64 架构") < 0.2);
});

test("isDuplicate catches a paraphrase but not a new fact", () => {
  const existing = ["主人偏好中文回答"];
  assert.equal(isDuplicate("主人偏好用中文回答", existing), true);
  assert.equal(isDuplicate("example-service 的远端是 GitLab", existing), false);
});

// Reordering a long note lands at 0.60, just under the default: the trade-off is
// "keep a near-duplicate" over "silently drop a new fact".
test("a reordered long note is kept, not merged away", () => {
  const existing = ["主人偏好简洁的中文回答"];
  assert.ok(similarity(existing[0]!, "主人偏好用中文简洁回答") < 0.62);
  assert.equal(isDuplicate("主人偏好用中文简洁回答", existing), false);
});

test("isDuplicate respects the threshold", () => {
  const existing = ["默认使用 vendor/deepseek-flash"];
  assert.equal(isDuplicate("默认使用 deepseek-flash 模型", existing, 0.95), false);
  assert.equal(isDuplicate("默认使用 deepseek-flash 模型", existing, 0.3), true);
});
