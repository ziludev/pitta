import assert from "node:assert/strict";
import { test } from "node:test";
import { formatTokens, parseModelCommand, turnMeta } from "../src/feishu.ts";

/**
 * `/model` in the Feishu chat, and the one line under every answer card that says what it cost.
 * Both are small, and both are the kind of thing that silently drifts, so the shapes are pinned.
 */

test("/model forms", () => {
  assert.deepEqual(parseModelCommand(""), { kind: "list" });
  assert.deepEqual(parseModelCommand("   "), { kind: "list" });
  assert.deepEqual(parseModelCommand("vendor/deepseek-v4-pro"), {
    kind: "set",
    modelId: "vendor/deepseek-v4-pro",
  });
  assert.deepEqual(parseModelCommand("default auto/glm-5.3"), { kind: "default", modelId: "auto/glm-5.3" });
  assert.deepEqual(parseModelCommand("thinking high"), { kind: "thinking", level: "high" });
  // A model id that merely starts with a keyword is still an id.
  assert.deepEqual(parseModelCommand("defaultish/x"), { kind: "set", modelId: "defaultish/x" });
});

test("tokens read as a person would write them", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(940), "940");
  assert.equal(formatTokens(12_345), "12.3k");
  assert.equal(formatTokens(1_000_000), "1000.0k");
});

test("the card line carries tools, tokens, money and the model", () => {
  const line = turnMeta({
    tools: 14,
    tokens: 12_345,
    costUsd: 0.0312,
    model: "deepseek-flash",
    thinking: "high",
  });
  // No duration: the "答完了" ping right below the card already carries it.
  assert.equal(line, "✅ · 14 个工具 · 12.3k tokens · $0.0312 · deepseek-flash · thinking high");
});

test("a turn that spent nothing still shows the tick", () => {
  const line = turnMeta({ tools: 0, tokens: 0, costUsd: 0, model: "", thinking: "" });
  assert.equal(line, "✅");
});
