import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTool,
  type ConversationId,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROLES, toolsFor, type RoleName } from "./roles.ts";
import { log, logError } from "./log.ts";

const ROLE_NAMES = Object.keys(ROLES) as RoleName[];
const CHILD_MAP = "subagents:children";

type SubagentResult = { ok: true; text: string; conversationId: number } | { ok: false; error: string };

function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLE_NAMES as string[]).includes(value);
}

/**
 * A subagent is just another conversation, owned by the tool task that started it.
 * Durable gives us four things for free: it survives a crash, it counts its own
 * cost, aborting the call aborts it, and a replay-safe tool that reruns finds the
 * same child instead of spawning a second one.
 */
async function ensureChild(
  api: ToolExecutionApi,
  context: Context,
  key: string,
  role: RoleName,
): Promise<ConversationId> {
  const map = (await api.memo<Record<string, number>>(CHILD_MAP, context)) ?? {};
  const known = map[key];
  if (known !== undefined) return known as unknown as ConversationId;

  const created = await api.commit(async (tx) => {
    const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
    await configure(tx, conversation.id, {
      // A child must not be able to delegate again: one level of fan-out, bounded cost.
      extensions: { remove: [subagentExtension] },
      instructions: `${ROLES[role].instructions}\n\n角色上限：${ROLES[role].maxTurns} 轮工具调用。`,
      ...toolsFor(role),
      maxTurns: ROLES[role].maxTurns,
    });
    return conversation.id as unknown as number;
  }, context);

  // First write wins: a retry after a crash keeps the child that already exists.
  await api.memo(CHILD_MAP, { ...map, [key]: created }, context);
  log("subagent", `spawned ${role}`, { key, conversationId: created });
  return created as unknown as ConversationId;
}

async function readAnswer(api: ToolExecutionApi, context: Context, answerId: unknown): Promise<string> {
  const entry = await api.commit((tx) => tx.entry(AssistantEntry, answerId as never), context);
  const messages = (entry?.model ?? []) as unknown as Array<{ content?: unknown }>;
  const parts: string[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
    }
  }
  return parts.join("").trim();
}

async function runChild(
  api: ToolExecutionApi,
  context: Context,
  key: string,
  role: RoleName,
  task: string,
): Promise<SubagentResult> {
  try {
    const conversationId = await ensureChild(api, context, key, role);
    const child = await api.conversation(conversationId, context);
    if (child === undefined) return { ok: false, error: `子会话 ${conversationId} 丢失` };
    const submission = await child.submit(
      { type: "input", content: task, requestId: `subagent:${api.taskId}:${key}` },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.answer === undefined) {
      return { ok: false, error: `${role} 没答出来：${settled.reason ?? "unanswered"}` };
    }
    const text = await readAnswer(api, context, settled.answer);
    log("subagent", `${role} answered`, { key, chars: text.length });
    return { ok: true, text, conversationId: conversationId as unknown as number };
  } catch (error) {
    logError("subagent", `${role} failed`, error);
    return { ok: false, error: `${role}: ${(error as Error).message}` };
  }
}

const delegate = defineTool({
  name: "delegate",
  description:
    "派活给一个专职子 agent：planner（拆需求）/ designer（写设计文档）/ implementer（实现）/ tester（写测试）/ reviewer（只读评审）。子 agent 有自己的会话和上下文，返回它的结论。适合把一件明确的事整体外包。",
  parameters: obj({
    role: str({ description: ROLE_NAMES.join(" | ") }),
    task: str({ description: "给这个角色的完整指令：目标、已知信息、期望产出" }),
  }),
  // Rerunning after a crash must find the same child conversation, not spawn another.
  replay: "safe",
  execute: async (args, api, context) => {
    if (!isRole(args.role)) {
      return { output: [{ type: "text" as const, text: `未知角色 ${args.role}，可选：${ROLE_NAMES.join(", ")}` }] };
    }
    api.output(`派给 ${args.role}（${ROLES[args.role].title}）…`);
    const result = await runChild(api, context, "delegate", args.role, args.task);
    if (!result.ok) {
      return { output: [{ type: "text" as const, text: `失败：${result.error}` }], isError: true };
    }
    await api.details({ conversationId: result.conversationId, role: args.role }, context);
    return {
      output: [{ type: "text" as const, text: `【${args.role} 的产出】\n${result.text}` }],
      details: { conversationId: result.conversationId, role: args.role },
    };
  },
});

const delegateParallel = defineTool({
  name: "delegate_parallel",
  description:
    "并行派给多个角色，全部完成后汇总。适合互不依赖的事（例如同时做 reviewer 评审 + tester 写测试）。",
  parameters: obj({
    tasks: str({
      description:
        'JSON 数组：[{"role":"designer","task":"…"},{"role":"reviewer","task":"…"}]。按字符串传入。',
    }),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    let tasks: Array<{ role?: string; task?: string }>;
    try {
      tasks = JSON.parse(args.tasks) as Array<{ role?: string; task?: string }>;
    } catch {
      return { output: [{ type: "text" as const, text: "tasks 必须是 JSON 数组字符串" }], isError: true };
    }
    const jobs = tasks
      .filter((item) => isRole(item.role) && typeof item.task === "string")
      .map((item, index) => ({ role: item.role as RoleName, task: item.task as string, key: `parallel-${index}` }));
    if (jobs.length === 0) {
      return { output: [{ type: "text" as const, text: "没有有效的任务" }], isError: true };
    }
    api.output(`并行派发给 ${jobs.map((job) => job.role).join(" / ")}…`);
    const results = await Promise.all(jobs.map((job) => runChild(api, context, job.key, job.role, job.task)));
    const text = results
      .map((result, index) => {
        const job = jobs[index]!;
        return result.ok ? `【${job.role}】\n${result.text}` : `【${job.role}】失败：${result.error}`;
      })
      .join("\n\n---\n\n");
    const failed = results.filter((result) => !result.ok).length;
    return {
      output: [{ type: "text" as const, text }],
      isError: failed === results.length ? true : undefined,
      details: { roles: jobs.map((job) => job.role), failed } as never,
    };
  },
});

const buildFeature = defineTool({
  name: "build_feature",
  description:
    "把一个需求跑完整流水线：designer 写设计文档 → implementer 实现并自测 → tester 写测试并跑。三步各自是独立子 agent，串行交接。适合「这个需求做一下」这种整体开工。",
  parameters: obj({
    spec: str({ description: "需求描述：要做什么、边界、验收标准" }),
    skipTests: opt(str({ description: "传 \"1\" 跳过测试阶段" })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    const stages: Array<{ role: RoleName; key: string; prompt: string }> = [
      {
        role: "designer",
        key: "feature-design",
        prompt: `需求：\n${args.spec}\n\n请写设计文档并保存到 workspace/docs/ 下，给出路径、摘要和给实现者的注意事项。`,
      },
    ];
    if (args.skipTests !== "1") {
      stages.push({
        role: "tester",
        key: "feature-test",
        prompt: "", // filled after implementation
      });
    }

    const report: string[] = [];
    let design = "";
    api.output("① designer 写设计文档…");
    const designResult = await runChild(api, context, "feature-design", "designer", stages[0]!.prompt);
    if (!designResult.ok) {
      return { output: [{ type: "text" as const, text: `设计阶段失败：${designResult.error}` }], isError: true };
    }
    design = designResult.text;
    report.push(`【designer】\n${design}`);

    api.output("② implementer 实现…");
    const implementResult = await runChild(
      api,
      context,
      "feature-implement",
      "implementer",
      `需求：\n${args.spec}\n\n设计文档与注意事项：\n${design}\n\n请实现并自测，然后按约定格式汇报。`,
    );
    if (!implementResult.ok) {
      return {
        output: [{ type: "text" as const, text: `${report.join("\n\n")}\n\n实现阶段失败：${implementResult.error}` }],
        isError: true,
      };
    }
    report.push(`【implementer】\n${implementResult.text}`);

    if (args.skipTests !== "1") {
      api.output("③ tester 写测试并运行…");
      const testResult = await runChild(
        api,
        context,
        "feature-test",
        "tester",
        `需求：\n${args.spec}\n\n设计摘要：\n${design}\n\n实现者的汇报：\n${implementResult.text}\n\n请按约定写测试并运行一次。`,
      );
      report.push(testResult.ok ? `【tester】\n${testResult.text}` : `【tester】失败：${testResult.error}`);
    }

    return {
      output: [{ type: "text" as const, text: report.join("\n\n---\n\n") }],
      details: { stages: report.length } as never,
    };
  },
});

export const subagentExtension = defineExtension({
  name: "subagents",
  tools: [delegate, delegateParallel, buildFeature],
});
