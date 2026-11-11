import { defineExtension, section } from "@earendil-works/pi-durable";
import { LARK_TOOLS } from "./lark-tools.ts";
import { PROJECT_TOOLS } from "./project-tools.ts";
import { SUBAGENT_TOOLS } from "./subagents.ts";

/**
 * Tools that stay installed but leave the model's schema, found through `tool_search` when a
 * request actually needs one.
 *
 * Every request carries every tool's schema: the full set here measured 8.3KB (~2.3k tokens), and
 * MCP servers add more on top. These ten — the owner's Feishu identity, subagent fan-out, and
 * opening a project — are rare per message and never needed by a group turn, so they carry
 * `deferred: true` in their own definition and are the ones worth deferring. `tool_search` writes
 * what it loads into the conversation's `modelTools.add`, so a tool stays offered on that branch,
 * also after a compaction.
 */
export const DEFERRED_TOOLS = [...LARK_TOOLS, ...SUBAGENT_TOOLS, ...PROJECT_TOOLS];

/** One line per deferred tool: its name is what `tool_search` matches, the hint is what the model reads. */
const HINTS: Record<string, string> = {
  feishu_agenda: "读我的飞书日程",
  feishu_tasks: "看飞书待办",
  feishu_create_task: "建飞书待办（会写你的飞书）",
  feishu_doc_read: "读飞书文档",
  delegate: "派一个子 agent 去做一件事",
  delegate_parallel: "并行派几个子 agent",
  build_feature: "需求流水线（拆解→设计→实现→测试）",
  task_status: "看子 agent 的进度",
  cancel_task: "取消子 agent",
  open_project: "把一个 git 仓库加进来当项目",
};

/**
 * Deferring a tool only saves tokens if the model knows it exists. This lists the names — a line,
 * not a schema — so "查一下日程" turns into `tool_search`, instead of the model hunting through
 * skills and bash for a way to reach Feishu (which is what it did without this section).
 */
const deferredSection = section("deferred_tools", () => {
  const lines = DEFERRED_TOOLS.map((tool) => {
    const hint = HINTS[tool.name];
    return hint === undefined ? tool.name : `${tool.name}（${hint}）`;
  });
  if (lines.length === 0) return undefined;
  return [
    "这些工具默认不加载（省上下文）。需要它们时先用 `tool_search` 搜一下名字，下一轮就能直接调用：",
    ...lines.map((line) => `- ${line}`),
  ].join("\n");
});

export const deferredExtension = defineExtension({ name: "deferred-tools", sections: [deferredSection] });
