/**
 * Feishu render self-test: sends one card and patches it twice, to prove the
 * bot's permissions and the streaming update path work before wiring events.
 *   npm run feishu-card -- oc_xxxxxxxx
 */
import * as Lark from "@larksuiteoapi/node-sdk";
import { requireFeishuCredentials } from "./config.ts";

const chatId = process.argv[2];
if (chatId === undefined || !chatId.startsWith("oc_")) {
  console.error("usage: node src/feishu-selftest.ts <chat_id (oc_...)>");
  process.exit(2);
}

const { appId, appSecret } = requireFeishuCredentials();
const client = new Lark.Client({ appId, appSecret });

function card(markdown: string, meta?: string): string {
  const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: markdown }];
  if (meta !== undefined) elements.push({ tag: "note", elements: [{ tag: "plain_text", content: meta }] });
  return JSON.stringify({ config: { wide_screen_mode: true, update_multi: true }, elements });
}

const created = await client.im.message.create({
  params: { receive_id_type: "chat_id" },
  data: { receive_id: chatId, msg_type: "interactive", content: card("🤔 self-test 1/3", "▶️ 处理中") },
});
const messageId = created?.data?.message_id;
if (messageId === undefined) {
  console.error("create failed", JSON.stringify(created).slice(0, 500));
  process.exit(1);
}
console.log("created", messageId);

await new Promise((resolve) => setTimeout(resolve, 800));
await client.im.message.patch({
  path: { message_id: messageId },
  data: { content: card("⚙️ self-test 2/3 — 这条是流式更新中的中间态", "▶️ 处理中") },
});
await new Promise((resolve) => setTimeout(resolve, 800));
await client.im.message.patch({
  path: { message_id: messageId },
  data: { content: card("✅ self-test 3/3 完成：卡片创建 + 两次原地更新都可用。", "✅ 1.6s") },
});
console.log("patched twice: streaming render path works");
