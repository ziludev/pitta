import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";

export type RoleName = "planner" | "designer" | "implementer" | "tester" | "reviewer";

export type Role = {
  title: string;
  instructions: string;
  /** Which of the coding tools the role may use. */
  tools: "read" | "write" | "full" | "none";
  /**
   * Steps one stage may take. A stage reads before it writes — a design document means exploring a
   * real repository — so a limit tuned for a single answer cut stages off mid-work (designer at 20,
   * implementer at 40) and the pipeline failed on `turn_limit` rather than on the work.
   */
  maxTurns: number;
};

const shared = `你在一个多角色协作里担任其中一个角色。
- 只做本角色的工作，不要越界代做别人的部分。
- 输出要让下一个人能直接拿去用：文件写盘并给路径，结论放前面。
- 不确定的地方写成「假设」，不要停下来反问。`;

export const ROLES: Record<RoleName, Role> = {
  planner: {
    title: "拆解需求",
    instructions: `${shared}
你的角色：把需求拆成可执行的步骤，标出依赖、风险和验收标准。不要写代码、不要写文档正文，只给拆解结果（步骤列表 + 每步产出物）。`,
    tools: "read",
    maxTurns: 24,
  },
  designer: {
    title: "写设计文档",
    instructions: `${shared}
你的角色：写技术设计文档。结构固定为：目标 / 非目标 / 方案 / 数据与接口 / 取舍 / 风险 / 验收标准。
把文档写到 workspace 下的 \`docs/<slug>.md\`（目录不存在就建），然后在回复里给出：
1) 文件路径 2) 不超过 200 字的方案摘要 3) 给实现者的注意事项清单。
不要改业务代码，不要写测试。`,
    tools: "write",
    maxTurns: 50,
  },
  implementer: {
    title: "实现",
    instructions: `${shared}
你的角色：按设计文档实现代码，跑通构建。
先读设计文档再动手；实现完必须自己运行一次（构建或最小可跑验证），把命令和输出贴出来。
回复结构：改动清单（文件 -> 一句话）/ 验证命令与结果 / 遗留问题。`,
    tools: "full",
    maxTurns: 100,
  },
  tester: {
    title: "写测试",
    instructions: `${shared}
你的角色：为已实现的代码写测试用例并跑一次。
覆盖：正常路径、边界、错误路径。测试写到项目约定位置；跑不起来要说明原因而不是假装通过。
回复结构：新增测试文件 / 覆盖点清单 / 运行命令与结果（通过数/失败数）/ 发现的缺陷。`,
    tools: "full",
    maxTurns: 60,
  },
  reviewer: {
    title: "评审",
    instructions: `${shared}
你的角色：只读评审。挑出真实问题：正确性、边界、命名、重复、缺测试。不要改文件。
回复结构：必须改（阻塞）/ 建议改 / 看着没问题，每条带文件与理由。没有问题的部分就直说没问题。`,
    tools: "read",
    maxTurns: 20,
  },
};

export function toolsFor(role: RoleName) {
  const read = createReadTool();
  const write = createWriteTool();
  const edit = createEditTool();
  const bash = createBashTool();
  switch (ROLES[role].tools) {
    case "none":
      return { tools: [] };
    case "read":
      return { tools: [read, bash] };
    case "write":
      return { tools: [read, write, edit, bash] };
    case "full":
    default:
      return { tools: [read, write, edit, bash] };
  }
}
