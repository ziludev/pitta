import assert from "node:assert/strict";
import test from "node:test";
import { renderEnv } from "../src/cli/env-file.ts";

test("setup appends the keys a fresh .env lacks", () => {
  const out = renderEnv("", { FEISHU_APP_ID: "cli_a", AGENT_PROVIDER: "deepseek" });
  assert.equal(out, "FEISHU_APP_ID=cli_a\nAGENT_PROVIDER=deepseek\n");
});

test("setup replaces values in place and keeps comments, order and unknown keys", () => {
  const before = [
    "# 飞书自建应用",
    "FEISHU_APP_ID=old",
    "SOMETHING_HAND_WRITTEN=keep",
    "",
    "# 模型",
    "AGENT_PROVIDER=magpie",
  ].join("\n");
  const out = renderEnv(before, { FEISHU_APP_ID: "new", AGENT_PROVIDER: "deepseek" });
  assert.equal(
    out,
    ["# 飞书自建应用", "FEISHU_APP_ID=new", "SOMETHING_HAND_WRITTEN=keep", "", "# 模型", "AGENT_PROVIDER=deepseek", ""].join(
      "\n",
    ),
  );
});

test("a replaced key is not appended a second time", () => {
  const out = renderEnv("FEISHU_APP_ID=old\n", { FEISHU_APP_ID: "new" });
  assert.equal(out.split("FEISHU_APP_ID").length - 1, 1);
  assert.ok(out.includes("FEISHU_APP_ID=new"));
});

test("a cleared value stays an empty assignment rather than a missing key", () => {
  const out = renderEnv("FEISHU_ALLOWED_CHAT_IDS=oc_1\n", { FEISHU_ALLOWED_CHAT_IDS: "" });
  assert.equal(out, "FEISHU_ALLOWED_CHAT_IDS=\n");
});
