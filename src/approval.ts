import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { requestApproval, surfaceForConversation } from "./channel.ts";

/** Commands that can destroy work or reach outside the sandbox. Kept short on purpose. */
const RISKY: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, reason: "删除文件" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, reason: "强推远端" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "丢弃本地改动" },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*[fd]/, reason: "删除未跟踪文件" },
  { pattern: /\bsudo\b/, reason: "提权执行" },
  { pattern: /\b(mkfs|diskutil\s+erase|dd\s+if=)/, reason: "写磁盘" },
  { pattern: />\s*\/dev\/(sd|disk|rdisk)/, reason: "写裸设备" },
  { pattern: /\bchmod\s+(-R\s+)?777\b/, reason: "放开文件权限" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, reason: "把网络内容直接交给 shell" },
  { pattern: /\bnpm\s+publish\b/, reason: "发布到 npm" },
  { pattern: /\bgh\s+(pr|release)\b.*(merge|create|delete)\b/, reason: "操作 GitHub 远端" },
  { pattern: /\bshutdown\b|\breboot\b/, reason: "关机/重启" },
];

const WRITE_TOOLS = new Set(["write", "edit"]);

/** Tools that change something outside the workspace, in someone else's system. */
const EXTERNAL_WRITES = new Set(["feishu_create_task"]);

function outsideWorkspace(path: string): boolean {
  const absolute = isAbsolute(path) ? path : resolve(config.workspace, path);
  const rel = relative(config.workspace, absolute);
  return rel.startsWith("..") || isAbsolute(rel);
}

/** Returns why a call needs a human, or undefined when it may run unattended. */
export function approvalReason(tool: string, args: Record<string, unknown>): string | undefined {
  if (tool === "bash" && typeof args["command"] === "string") {
    const command = args["command"];
    for (const risky of RISKY) {
      if (risky.pattern.test(command)) return `${risky.reason}：${command.slice(0, 120)}`;
    }
    return undefined;
  }
  if (EXTERNAL_WRITES.has(tool)) {
    return `会写入你的飞书：${JSON.stringify(args).slice(0, 200)}`;
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    if (path.length > 0 && outsideWorkspace(path)) return `写到工作区之外：${path}`;
  }
  return undefined;
}

const APPROVAL_TIMEOUT_MS = 180_000;

export const guardExtension = defineExtension({
  name: "guard",
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        const reason = approvalReason(call.name, args);
        if (reason === undefined) return undefined;

        const memoKey = `approval:${call.id}`;
        // A hook reruns after a crash: reuse the stored answer instead of asking twice.
        const decided = await api.memo<boolean>(memoKey, context);
        if (decided !== undefined) {
          return decided ? undefined : { block: `主人拒绝了这次操作（${reason}）` };
        }

        const surfaceId = surfaceForConversation(api.conversationId) ?? "";
        console.log(`[guard] asking approval for ${call.name}: ${reason}`);
        const approved = await requestApproval({
          callId: call.id,
          conversationId: api.conversationId as unknown as number,
          tool: call.name,
          summary: summarize(call.name, args),
          reason,
          surfaceId,
          timeoutMs: APPROVAL_TIMEOUT_MS,
        });
        await api.memo(memoKey, approved, context);
        console.log(`[guard] ${call.name} ${approved ? "approved" : "denied"}`);
        return approved ? undefined : { block: `未获批准（${reason}）` };
      },
    }),
  ],
});

function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === "bash" && typeof args["command"] === "string") return args["command"].slice(0, 600);
  const path = typeof args["path"] === "string" ? args["path"] : "?";
  if (tool === "write") {
    const content = typeof args["content"] === "string" ? args["content"] : "";
    return `${path}\n\n${content.slice(0, 400)}`;
  }
  if (tool === "edit") {
    return `${path}\n\n${String(args["newText"] ?? args["new_text"] ?? "").slice(0, 400)}`;
  }
  return `${tool} ${JSON.stringify(args).slice(0, 400)}`;
}
