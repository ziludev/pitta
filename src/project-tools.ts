import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { Context } from "@earendil-works/chord/context";
import { getRuntime } from "./runtime-ref.ts";
import { ConversationProjectDoc, ProjectsDoc } from "./projects.ts";
import { log } from "./log.ts";

/**
 * Feishu has one conversation per group and no project picker, so the model needs a way
 * to say "work in example-service" and get a worktree there. The client has UI for this;
 * in chat the tool is the only surface.
 */
const openProject = defineTool({
  name: "open_project",
  deferred: true,
  description:
    "切换工作仓库。当主人让你改/查另一个 git 仓库（如「看看 example-service 的日志」「修一下 flicker」）时先调用它：会切到该仓库并为本会话建独立 worktree 与分支，之后 bash/read/write 都作用在新仓库里，对话上下文保留。不带 project 则列出可用项目。",
  parameters: obj({
    project: opt(str({ description: "项目名、id 或路径片段" })),
    base: opt(str({ description: "从这个分支开 worktree，默认仓库的当前分支" })),
  }),
  replay: "safe",
  execute: async (args, api, context: Context) => {
    const runtime = getRuntime();
    if (runtime === undefined) {
      return { output: [{ type: "text" as const, text: "运行时还没就绪，稍后再试" }] };
    }
    const projects = await runtime.projects();
    const currentId = await runtime.projectOfConversation(api.conversationId as unknown as number);

    if (args.project === undefined || args.project.trim().length === 0) {
      const lines = projects.map(
        (project) =>
          `- ${project.name}（id \`${project.id}\`）${project.id === currentId ? " ← 当前" : ""} — ${project.path}`,
      );
      return {
        output: [
          {
            type: "text" as const,
            text: lines.length > 0 ? `可用项目：\n${lines.join("\n")}` : "还没有任何项目",
          },
        ],
      };
    }

    const result = await runtime.switchProject(
      api.conversationId as unknown as number,
      args.project,
      args.base,
    );
    if ("error" in result) {
      return {
        output: [
          {
            type: "text" as const,
            text: `${result.error}\n可选：${result.candidates.join("、") || "（无）"}`,
          },
        ],
      };
    }
    log("project", "open_project", {
      conversationId: api.conversationId as unknown as number,
      project: result.project.id,
      dir: result.dir,
    });
    return {
      output: [
        {
          type: "text" as const,
          text: `已切到项目 ${result.project.name}，工作目录 ${result.dir}，分支 ${result.branch}。之后的命令都在这里执行。`,
        },
      ],
    };
  },
});

/** Tells the model which repos exist, so it can offer them instead of guessing paths. */
const projectSection = section("projects", async (input, context) => {
  const doc = await input.read.snapshot(ProjectsDoc, context).catch(() => undefined);
  const projects = doc?.projects ?? [];
  if (projects.length === 0) return "";
  const binding = await input.read
    .snapshot(ConversationProjectDoc, context)
    .catch(() => undefined);
  const currentId = binding?.byConversation[String(input.conversationId)];
  const base = binding?.baseByConversation?.[String(input.conversationId)];
  const lines = projects.map(
    (project) =>
      `- ${project.name}${project.id === currentId ? ` ← 当前会话${base === undefined ? "" : `，基线 ${base}`}` : ""}`,
  );
  return [
    "可用的 git 项目（要动哪个仓库，先 open_project 切过去）：",
    ...lines,
  ].join("\n");
});

/** Deferred per conversation: opening a project is rare, and the schema is not free. */
export const PROJECT_TOOLS = [openProject];

export const projectExtension = defineExtension({
  name: "projects",
  tools: PROJECT_TOOLS,
  sections: [projectSection],
});
