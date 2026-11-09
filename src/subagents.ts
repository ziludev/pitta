import {
  AssistantEntry,
  configure,
  defineExtension,
  defineTask,
  defineTool,
  type ConversationId,
  type Tx,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { obj, opt, str } from "@earendil-works/pi-schema";
import type { TaskRuntime, ToolExecutionApi } from "@earendil-works/pi-durable";
import { ROLES, toolsFor, type RoleName } from "./roles.ts";
import { notify, surfaceForConversation } from "./channel.ts";
import { getHarness } from "./runtime-ref.ts";
import { log, logError } from "./log.ts";

const ROLE_NAMES = Object.keys(ROLES) as RoleName[];
const CHILD_MAP = "subagents:children";

type SubagentResult = { ok: true; text: string; conversationId: number } | { ok: false; error: string };

function isRole(value: unknown): value is RoleName {
  return typeof value === "string" && (ROLE_NAMES as string[]).includes(value);
}

/**
 * Every child is a task-owned conversation with the role's instructions and tools.
 * A child never gets the delegate tools again: one level of fan-out, bounded cost.
 */
async function configureChild(tx: Tx, id: ConversationId, role: RoleName): Promise<void> {
  await configure(tx, id, {
    extensions: { remove: [subagentExtension] },
    instructions: `${ROLES[role].instructions}\n\n角色上限：${ROLES[role].maxTurns} 轮工具调用。`,
    ...toolsFor(role),
    maxTurns: ROLES[role].maxTurns,
  });
}

function answerText(messages: readonly { content?: unknown }[] | undefined): string {
  const parts: string[] = [];
  for (const message of messages ?? []) {
    if (!Array.isArray(message.content)) continue;
    for (const part of message.content as Array<Record<string, unknown>>) {
      if (part["type"] === "text" && typeof part["text"] === "string") parts.push(part["text"]);
    }
  }
  return parts.join("").trim();
}

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
    await configureChild(tx, conversation.id, role);
    return conversation.id as unknown as number;
  }, context);

  // First write wins: a retry after a crash keeps the child that already exists.
  await api.memo(CHILD_MAP, { ...map, [key]: created }, context);
  log("subagent", `spawned ${role}`, { key, conversationId: created });
  return created as unknown as ConversationId;
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

    api.output(`→ ${role}（${ROLES[role].title}）开始…\n`);
    const submission = await child.submit(
      { type: "input", content: task, requestId: `subagent:${api.taskId}:${key}` },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.answer === undefined) {
      return { ok: false, error: `${role} 没答出来：${settled.reason ?? "unanswered"}` };
    }
    const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer as never), context);
    const text = answerText(entry?.model as unknown as { content?: unknown }[] | undefined);
    log("subagent", `${role} answered`, { key, chars: text.length });
    api.output(`✔ ${role} 完成（${text.length} 字）\n`);
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
      description: 'JSON 数组：[{"role":"designer","task":"…"},{"role":"reviewer","task":"…"}]。按字符串传入。',
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

// ---- background pipeline ---------------------------------------------------

export type FeatureInput = {
  spec: string;
  /** Where to report when it finishes. */
  surfaceId: string;
  /** Parent conversation, so the result also lands in its transcript. */
  parentConversationId: number;
  skipTests: boolean;
};

type StageKey = "feature-design" | "feature-implement" | "feature-test";

/**
 * The same pipeline as the synchronous tool, but as a background durable task:
 * the conversation goes idle immediately, the stages keep running, and the owner
 * gets one message when it is done. A crash resumes at the first unfinished stage
 * because each stage's output is memoized.
 */
export const FeatureTask = defineTask<FeatureInput, { phase: "run" }, string>({
  name: "app.feature",
  version: 1,
  initial: () => ({ phase: "run" }),
  phases: {
    run: async (task, runtime, context) => {
      const stages: Array<{ key: StageKey; role: RoleName; title: string }> = [
        { key: "feature-design", role: "designer", title: "写设计文档" },
        { key: "feature-implement", role: "implementer", title: "实现" },
      ];
      if (!task.input.skipTests) {
        stages.push({ key: "feature-test", role: "tester", title: "写测试" });
      }

      const outputs: Record<string, string> = {};
      for (const stage of stages) {
        const done = await runtime.memo<string>(`stage:${stage.key}`, context);
        if (done !== undefined) {
          outputs[stage.key] = done;
          continue;
        }
        const result = await runStage(runtime, task, context, stage.key, stage.role, stage.title, outputs, task.input.spec);
        if (!result.ok) {
          await report(runtime, task, context, `❌ ${stage.role} 失败了：${result.error}`);
          await runtime.commit(
            () => ({ status: "terminal", outcome: { status: "failed", error: { message: result.error } } }),
            context,
          );
          return;
        }
        outputs[stage.key] = result.text;
      }

      const summary = buildSummary(task.input.spec, outputs, stages);
      await report(runtime, task, context, summary);
      await runtime.commit(
        () => ({ status: "terminal", outcome: { status: "completed", result: summary } }),
        context,
      );
    },
  },
  abort: (_task, runtime, context) =>
    runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context),
});

async function runStage(
  runtime: TaskRuntime<FeatureInput, { phase: "run" }, string, object>,
  task: { input: FeatureInput; id: unknown },
  context: Context,
  key: StageKey,
  role: RoleName,
  title: string,
  previous: Record<string, string>,
  spec: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  try {
    const existing = await runtime.memo<number>(`child:${key}`, context);
    let childId = existing;
    if (childId === undefined) {
      let created = 0;
      await runtime.commit(async (tx) => {
        const conversation = await tx.createConversation({
          ownership: { kind: "task", taskId: task.id as never },
        });
        await configureChild(tx, conversation.id, role);
        created = conversation.id as unknown as number;
        return undefined;
      }, context);
      childId = created;
      await runtime.memo(`child:${key}`, childId, context);
      log("feature", `spawned ${role}`, { key, conversationId: childId });
    }

    const child = await runtime.conversation(childId as never, context);
    if (child === undefined) return { ok: false, error: `子会话 ${childId} 丢失` };

    const prompt = buildStagePrompt(key, spec, previous);
    const submission = await child.submit(
      { type: "input", content: prompt, requestId: `feature:${String(task.id)}:${key}` },
      context,
    );
    const settled = await submission.wait(context);
    if (settled.status !== "done" || settled.answer === undefined) {
      return { ok: false, error: `${role} 没答出来：${settled.reason ?? "unanswered"}` };
    }
    // Read through a transaction: the plain `runtime.entry()` record did not carry the
    // model messages, which silently produced empty stage output.
    let text = "";
    await runtime.commit(async (tx) => {
      const entry = await tx.entry(AssistantEntry, settled.answer as never);
      text = answerText(entry?.model as unknown as { content?: unknown }[] | undefined);
      return undefined;
    }, context);
    if (text.length === 0) return { ok: false, error: `${role} 产出为空` };
    await runtime.memo(`stage:${key}`, text, context);
    log("feature", `${role} done`, { key, chars: text.length });
    return { ok: true, text };
  } catch (error) {
    logError("feature", `${title} failed`, error);
    return { ok: false, error: `${role}: ${(error as Error).message}` };
  }
}

function buildStagePrompt(key: StageKey, spec: string, previous: Record<string, string>): string {
  const design = previous["feature-design"] ?? "";
  const implementation = previous["feature-implement"] ?? "";
  if (key === "feature-design") {
    return `需求：\n${spec}\n\n请写设计文档并保存到 workspace/docs/ 下，给出路径、摘要和给实现者的注意事项。`;
  }
  if (key === "feature-implement") {
    return `需求：\n${spec}\n\n设计文档与注意事项：\n${design}\n\n请实现并自测，然后按约定格式汇报。`;
  }
  return `需求：\n${spec}\n\n设计摘要：\n${design}\n\n实现者的汇报：\n${implementation}\n\n请按约定写测试并运行一次。`;
}

function buildSummary(spec: string, outputs: Record<string, string>, stages: ReadonlyArray<{ key: string }>): string {
  const body = stages
    .map((stage) => {
      const text = outputs[stage.key] ?? "";
      return `**${stage.key.replace("feature-", "")}**\n${text.slice(0, 900)}`;
    })
    .join("\n\n");
  return `需求：${spec.slice(0, 200)}\n\n${body}`;
}

async function report(
  runtime: TaskRuntime<FeatureInput, { phase: "run" }, string, object>,
  task: { input: FeatureInput },
  context: Context,
  text: string,
): Promise<void> {
  // Land it in the parent transcript so the conversation remembers what happened,
  // then push one message: the owner should not have to poll.
  await runtime.commit(async (tx) => {
    await tx.appendEntry(task.input.parentConversationId as never, {
      kind: "app.feature-report",
      data: { text: text.slice(0, 4000) } as never,
    });
    return undefined;
  }, context);
  const surfaceId = surfaceForConversation(task.input.parentConversationId) ?? task.input.surfaceId;
  if (surfaceId.length > 0) {
    await notify(surfaceId, `🧩 需求做完了\n\n${text.slice(0, 3000)}`).catch((error) =>
      logError("feature", "could not notify", error),
    );
  }
}

const buildFeature = defineTool({
  name: "build_feature",
  description:
    "把需求跑完整流水线：designer 写设计文档 → implementer 实现自测 → tester 写测试。background=\"1\" 时丢到后台跑，立即返回，完成后主动发消息（推荐，尤其是要几分钟的活）；否则同步等待结果。",
  parameters: obj({
    spec: str({ description: "需求描述：要做什么、边界、验收标准" }),
    background: opt(str({ description: '传 "1" 后台跑（推荐）' })),
    skipTests: opt(str({ description: '传 "1" 跳过测试阶段' })),
  }),
  replay: "safe",
  execute: async (args, api, context) => {
    if (args.background === "1") {
      const existing = await api.memo<number>("feature-task", context);
      if (existing !== undefined) {
        return {
          output: [{ type: "text" as const, text: `这个后台任务已经派过了（task ${existing}），完成会通知你。` }],
        };
      }
      const surfaceId = surfaceForConversation(api.conversationId) ?? "";
      const taskId = await api.createTask(
        FeatureTask,
        {
          spec: args.spec,
          surfaceId,
          parentConversationId: api.conversationId as unknown as number,
          skipTests: args.skipTests === "1",
        },
        // Background: outlives this turn, so the conversation goes idle while it runs.
        { ownership: { kind: "conversation" }, background: true },
        context,
      );
      await api.memo("feature-task", taskId as unknown as number, context);
      log("feature", "background task created", { taskId, surfaceId });
      return {
        output: [
          {
            type: "text" as const,
            text: `已在后台开工（task ${taskId}）：designer → implementer${
              args.skipTests === "1" ? "" : " → tester"
            }。做完我主动发你消息，期间你可以继续聊别的。`,
          },
        ],
      };
    }

    const report: string[] = [];
    api.output("① designer 写设计文档…");
    const design = await runChild(
      api,
      context,
      "feature-design",
      "designer",
      buildStagePrompt("feature-design", args.spec, {}),
    );
    if (!design.ok) {
      return { output: [{ type: "text" as const, text: `设计阶段失败：${design.error}` }], isError: true };
    }
    report.push(`【designer】\n${design.text}`);

    api.output("② implementer 实现…");
    const implementation = await runChild(
      api,
      context,
      "feature-implement",
      "implementer",
      buildStagePrompt("feature-implement", args.spec, { "feature-design": design.text }),
    );
    if (!implementation.ok) {
      return {
        output: [{ type: "text" as const, text: `${report.join("\n\n")}\n\n实现阶段失败：${implementation.error}` }],
        isError: true,
      };
    }
    report.push(`【implementer】\n${implementation.text}`);

    if (args.skipTests !== "1") {
      api.output("③ tester 写测试并运行…");
      const tests = await runChild(
        api,
        context,
        "feature-test",
        "tester",
        buildStagePrompt("feature-test", args.spec, {
          "feature-design": design.text,
          "feature-implement": implementation.text,
        }),
      );
      report.push(tests.ok ? `【tester】\n${tests.text}` : `【tester】失败：${tests.error}`);
    }

    return {
      output: [{ type: "text" as const, text: report.join("\n\n---\n\n") }],
      details: { stages: report.length } as never,
    };
  },
});


const taskStatus = defineTool({
  name: "task_status",
  description:
    "看后台任务状态：不传 taskId 列出当前所有在跑的后台任务（含 app.feature 流水线）；传 taskId 看单个详情。",
  parameters: obj({ taskId: opt(str({ description: "任务 id，可选" })) }),
  replay: "safe",
  execute: async (args, _api, context) => {
    const harness = getHarness();
    if (harness === undefined) {
      return { output: [{ type: "text" as const, text: "拿不到 harness 句柄" }], isError: true };
    }
    if (typeof args.taskId === "string" && args.taskId.length > 0) {
      const record = await harness.getTask(args.taskId as never, context);
      if (record === undefined) {
        return { output: [{ type: "text" as const, text: `没有 task ${args.taskId}（可能已经结束并被清理）` }] };
      }
      const state = record.state as unknown as { status?: string; kind?: string; outcome?: unknown };
      return {
        output: [
          {
            type: "text" as const,
            text: `task ${record.id}
kind: ${record.kind}
status: ${state.status ?? state.kind}
outcome: ${JSON.stringify(
              state.outcome ?? null,
            ).slice(0, 500)}`,
          },
        ],
      };
    }

    const inspection = await harness.inspect(context);
    const live = inspection.tasks.filter((task) => task.record.kind !== "pi.generation");
    if (live.length === 0) {
      return { output: [{ type: "text" as const, text: "现在没有在跑的后台任务" }] };
    }
    const lines = live.map((task) => {
      const state = task.state as unknown as { kind?: string } & Record<string, unknown>;
      const detail = state.kind === "running" ? "running" : state.kind ?? "?";
      return `- ${task.record.id} ${task.record.kind} [${detail}] conversation=${task.record.conversationId}`;
    });
    return { output: [{ type: "text" as const, text: `在跑的任务：\n${lines.join("\n")}` }] };
  },
});

const cancelTask = defineTool({
  name: "cancel_task",
  description: "取消一个后台任务（例如跑偏的 app.feature 流水线）。会级联停掉它拥有的子 agent。",
  parameters: obj({ taskId: str({ description: "要取消的 task id" }) }),
  execute: async (args, _api, context) => {
    const harness = getHarness();
    if (harness === undefined) {
      return { output: [{ type: "text" as const, text: "拿不到 harness 句柄" }], isError: true };
    }
    const result = await harness.abortTask(args.taskId as never, context);
    log("subagent", "cancel requested", { taskId: args.taskId, result });
    return {
      output: [
        {
          type: "text" as const,
          text: result === "terminal" ? `task ${args.taskId} 已经是结束状态` : `已取消 task ${args.taskId}（连带子 agent）`,
        },
      ],
    };
  },
});

export const subagentExtension = defineExtension({
  name: "subagents",
  tools: [delegate, delegateParallel, buildFeature, taskStatus, cancelTask],
  tasks: [FeatureTask],
});
