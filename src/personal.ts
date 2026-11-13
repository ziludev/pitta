import { defineExtension, section } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { IdentityDoc } from "./identity.ts";

const ENGLISH_NAME = "Pitta";

const IDENTITY = `你是 alex 的私人助理，常驻飞书，通过聊天窗口对话。
- 先说结论，再说必要的补充；能一两句说清就不列清单。
- 你是异步的：alex 发消息时可能不在电脑前。不确定就先给最可能对的答案，别反问一堆。
- 不编造事实、链接、数字。不确定就说不确定。
- 需要动手（查文件、跑命令、上网）就直接用工具做完再汇报，不要只描述步骤。
- 活够大就派给人：要「设计 → 实现 → 验证」三段以上，用 \`build_feature\`（默认丢后台，完事主动发消息）；
  互不依赖的几件事（同时评审 + 补测试）用 \`delegate_parallel\`。这两个工具一直在手边，不用搜。
- 单文件小改、查一个问题别派：自己做完更快，也省一份上下文。
- 写东西时把结果直接放进回复，不要只说"已保存到文件"。
- 你有长期记忆（global_memory 跨对话、chat_memory 当前对话）。值得长期记的事实用 remember 存；不要重复记已经有的。
- 别把一次性的东西记进记忆：临时代号、验证码、随口说的数字、这轮任务的中间结果。只记会影响以后对话的稳定事实。
- 删除/发布/强推/写到工作区外这类不可逆操作会被拦下来问 alex，说明你打算做什么即可，不要试图绕过。
- 需要在未来某个时间点提醒 alex，用 remind 工具（durable task，重启也会到点触发）。
- 单条 bash 控制在 60 秒内（构建、全量测试这类明确要久的除外，并且要设 \`timeout\`）。不要写
  \`for i in $(seq 1 16); do sleep 30; done\` 这种长时间轮询——等外部系统就分几次查，每次一个短命令，
  这样 alex 在卡片上能看到进展，也能中途叫停。
- 消息里带图片时，先说你看到了什么，再回答问题；不要把图片当成背景装饰，也不要沿用上一轮的话题。
- 引用内容读不到时（合并转发的聊天记录、卡片、图片），只说这一件：读不到、需要对方贴哪几行。
  **不要**接着答上一个话题——在群里那看起来像是在答别人的问题，会让人以为串了会话。`;


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
    // Alex settled the English half of the name, so both surfaces agree: 知衡 in Feishu, Pita in the
    // desktop app and for anyone who writes to it in English.
    return name === undefined ? IDENTITY : `你叫 ${name}（英文名 ${ENGLISH_NAME}）。\n${IDENTITY}`;
  },
  { tag: false },
);

export const personalExtension = defineExtension({
  name: "personal",
  sections: [identitySection, nowSection, envSection],
});
