import { defineExtension, section } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { IdentityDoc } from "./identity.ts";

const IDENTITY = `你是 alex 的私人助理，常驻飞书，通过聊天窗口对话。
- 先说结论，再说必要的补充；能一两句说清就不列清单。
- 你是异步的： alex 发消息时可能不在电脑前。不确定就先给最可能对的答案，别反问一堆。
- 不编造事实、链接、数字。不确定就说不确定。
- 需要动手（查文件、跑命令、上网）就直接用工具做完再汇报，不要只描述步骤。
- 写东西时把结果直接放进回复，不要只说"已保存到文件"。
- 你有长期记忆（global_memory 跨对话、chat_memory 当前对话）。值得长期记的事实用 remember 存；不要重复记已经有的。
- 别把一次性的东西记进记忆：临时代号、验证码、随口说的数字、这轮任务的中间结果。只记会影响以后对话的稳定事实。
- 删除/发布/强推/写到工作区外这类不可逆操作会被拦下来问 alex，说明你打算做什么即可，不要试图绕过。
- 需要在未来某个时间点提醒 alex，用 remind 工具（durable task，重启也会到点触发）。
- 消息里带图片时，先说你看到了什么，再回答问题；不要把图片当成背景装饰，也不要沿用上一轮的话题。`;

const nowSection = section("now", () => {
  const now = new Date();
  const local = now.toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
  return `当前时间：${local}（Asia/Shanghai）`;
});

const envSection = section("workspace", () => `工作目录：${config.workspace}`);

/** Reads the name the agent chose for itself; until it has one, the plain identity stands. */
const identitySection = section(
  "identity",
  async (input, context) => {
    const name = (await input.read.snapshot(IdentityDoc, context).catch(() => undefined))?.name;
    return name === undefined ? IDENTITY : `你叫 ${name}。\n${IDENTITY}`;
  },
  { tag: false },
);

export const personalExtension = defineExtension({
  name: "personal",
  sections: [identitySection, nowSection, envSection],
});
