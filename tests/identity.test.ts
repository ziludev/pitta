import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanName } from "../src/identity.ts";

/**
 * The agent names itself once, from one model answer. A model answers in sentences, so the reply
 * has to become a name: first line, first token, no quotes or explanation, and nothing absurd.
 */

test("a plain answer is the name", () => {
  assert.equal(cleanName("青鸟"), "青鸟");
  assert.equal(cleanName("  Atlas  "), "Atlas");
});

test("quotes, markdown and trailing punctuation come off", () => {
  assert.equal(cleanName("「青鸟」"), "青鸟");
  assert.equal(cleanName('"Atlas"'), "Atlas");
  assert.equal(cleanName("**青鸟**。"), "青鸟");
});

test("an explanation becomes just the name it starts with", () => {
  assert.equal(cleanName("我叫青鸟，因为……"), "青鸟");
  assert.equal(cleanName("Atlas — a name from the titan"), "Atlas");
  assert.equal(cleanName("青鸟\n希望你喜欢"), "青鸟");
});

test("an empty or absurd answer is no name at all", () => {
  assert.equal(cleanName(""), "");
  assert.equal(cleanName("   "), "");
  assert.equal(cleanName("。"), "");
  assert.equal(cleanName("a".repeat(30)), "");
});
