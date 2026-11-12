import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { requestApproval, surfaceForConversation } from "./channel.ts";
import { hasGrant } from "./grants.ts";
import { ChatPolicy, readRoots } from "./access.ts";
import { log } from "./log.ts";
import { record } from "./audit.ts";
import { getHarness, getSessionContext } from "./runtime-ref.ts";

/**
 * Commands that can destroy work or reach outside the sandbox. Kept short on purpose.
 * `key` is the risk class a conversation-wide grant is remembered under, so "allow for
 * this chat" covers the same kind of call and nothing else.
 */
const RISKY: Array<{ pattern: RegExp; reason: string; key: string }> = [
  // Long options and a flag after the path count too: `rm --recursive --force` and
  // `rm x -rf` destroy the same files as `rm -rf x`.
  { pattern: /\brm\s+([^|;&\n]*\s)?(-[a-zA-Z]*[rf]|--recursive\b|--force\b)/, reason: "删除文件", key: "rm" },
  { pattern: /\bfind\b[^|;&\n]*\s-delete\b/, reason: "批量删除文件", key: "rm" },
  { pattern: /\bgit\s+push\b.*(--force|-f\b)/, reason: "强推远端", key: "force-push" },
  // `git push origin +main` rewrites the remote branch without the word force.
  { pattern: /\bgit\s+push\b[^|;&\n]*\s\+[A-Za-z0-9._/-]+/, reason: "强推远端", key: "force-push" },
  { pattern: /\bgit\s+reset\s+--hard\b/, reason: "丢弃本地改动", key: "reset-hard" },
  { pattern: /\bgit\s+clean\s+-(?![a-zA-Z]*n)[a-zA-Z]*[fd]/, reason: "删除未跟踪文件", key: "git-clean" },
  { pattern: /\bsudo\b/, reason: "提权执行", key: "sudo" },
  { pattern: /\b(mkfs|diskutil\s+erase|dd\s+if=)/, reason: "写磁盘", key: "disk" },
  { pattern: />\s*\/dev\/(sd|disk|rdisk)/, reason: "写裸设备", key: "raw-device" },
  { pattern: /\bchmod\s+(-R\s+)?(0?777|[ugoa]*\+rwx)\b/, reason: "放开文件权限", key: "chmod-777" },
  { pattern: /\b(curl|wget)\b[^|]*\|\s*(ba|z)?sh\b/, reason: "把网络内容直接交给 shell", key: "pipe-to-shell" },
  { pattern: /\bnpm\s+publish\b/, reason: "发布到 npm", key: "npm-publish" },
  { pattern: /\bgh\s+(pr|release)\b.*(merge|create|delete)\b/, reason: "操作 GitHub 远端", key: "gh-write" },
  { pattern: /\bshutdown\b|\breboot\b/, reason: "关机/重启", key: "power" },
];

const WRITE_TOOLS = new Set(["write", "edit"]);

/** Tools that change something outside the workspace, in someone else's system. */
const EXTERNAL_WRITES = new Set(["feishu_create_task"]);

function outsideWorkspace(path: string): boolean {
  const absolute = isAbsolute(path) ? path : resolve(config.workspace, path);
  const rel = relative(config.workspace, absolute);
  return rel.startsWith("..") || isAbsolute(rel);
}

export type ApprovalNeed = { reason: string; key: string };

/** Returns why a call needs a human, or undefined when it may run unattended. */
export function approvalReason(tool: string, args: Record<string, unknown>): ApprovalNeed | undefined {
  if (tool === "bash" && typeof args["command"] === "string") {
    const command = args["command"];
    for (const risky of RISKY) {
      if (risky.pattern.test(command)) return { reason: `${risky.reason}：${command.slice(0, 120)}`, key: risky.key };
    }
    return undefined;
  }
  if (EXTERNAL_WRITES.has(tool)) {
    return { reason: `会写入你的飞书：${JSON.stringify(args).slice(0, 200)}`, key: "feishu-write" };
  }
  if (WRITE_TOOLS.has(tool)) {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    if (path.length > 0 && outsideWorkspace(path)) {
      return { reason: `写到工作区之外：${path}`, key: "write-outside" };
    }
  }
  return undefined;
}

/**
 * What a guest may call. A guest is anyone in a shared group who is not the owner.
 *
 * Read-only used to be a sentence in the instructions; it is now a decision here, before the
 * tool runs, because a prompt does not stop `cat .env`. Read is allowed so the bot can still
 * help with code questions in a group; the shell is not, because it can reach anything.
 */
const GUEST_TOOLS = new Set(["read", "skill", "recall", "remind", "logs_query", "project_search"]);

/** Even inside the workspace, a guest read must never return these. */
const GUEST_DENIED_PATHS = [
  /(^|\/)\.env([./]|$)/,
  /\.sqlite$/,
  /\.pem$/,
  /(^|\/)id_[A-Za-z0-9]+$/,
  /secret/i,
  /(^|\/)\.data(\/|$)/,
  /(^|\/)\.ssh(\/|$)/,
  /(^|\/)\.git(\/|$)/,
];

/** Why a guest call is refused, or undefined when it may run. */
export function guestBlockReason(
  tool: string,
  args: Record<string, unknown>,
  roots: readonly string[] = [config.workspace],
): string | undefined {
  if (!GUEST_TOOLS.has(tool)) {
    return `这个群是 guest 模式：不能用 ${tool}。需要改代码或跑命令，请 alex 在私聊里说。`;
  }
  if (tool === "read") {
    const path = typeof args["path"] === "string" ? args["path"] : "";
    if (outsideRoots(path, roots) || GUEST_DENIED_PATHS.some((pattern) => pattern.test(path))) {
      return `这个群是 guest 模式：不能读 ${path}（可读范围之外或敏感文件）。`;
    }
  }
  return undefined;
}

/** True when `path` is not inside any of the roots. The first root resolves a relative path. */
export function outsideRoots(path: string, roots: readonly string[]): boolean {
  const absolute = isAbsolute(path) ? path : resolve(roots[0] ?? config.workspace, path);
  return !roots.some((root) => {
    const rel = relative(root, absolute);
    return rel.length === 0 || (!rel.startsWith("..") && !isAbsolute(rel));
  });
}

/** Long enough to answer from a meeting; the run is blocked either way. */
const APPROVAL_TIMEOUT_MS = 600_000;

export const guardExtension = defineExtension({
  name: "guard",
  hooks: [
    hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        const args = (call.arguments ?? {}) as Record<string, unknown>;
        // A guest turn gets a smaller tool surface, decided here rather than in the prompt.
        const policy = await api
          .snapshot(ChatPolicy, api.conversationId as unknown as never, context)
          .catch(() => undefined);
        if (policy?.guest === true && policy.turn !== "owner") {
          const roots = await readRoots(api, api.conversationId as unknown as number, context);
          const blocked = guestBlockReason(call.name, args, roots);
          if (blocked !== undefined) {
            log("approval", "guest tool blocked", { tool: call.name });
            const auditHarness = getHarness();
            const auditContext = getSessionContext();
            if (auditHarness !== undefined && auditContext !== undefined) {
              void record(auditHarness, auditContext, { kind: "deny", tool: call.name, detail: "guest surface" });
            }
            return { block: blocked };
          }
          return undefined;
        }
        const need = approvalReason(call.name, args);
        if (need === undefined) return undefined;
        const { reason, key } = need;
        // "本会话内全部允许" already covered this class of call.
        if (hasGrant(api.conversationId as unknown as number, key)) {
          console.log(`[guard] ${call.name} allowed by session grant (${key})`);
          return undefined;
        }

        const memoKey = `approval:${call.id}`;
        // A hook reruns after a crash: reuse the stored answer instead of asking twice.
        const decided = await api.memo<boolean>(memoKey, context);
        if (decided !== undefined) {
          return decided ? undefined : { block: `alex 拒绝了这次操作（${reason}）` };
        }

        const surfaceId = surfaceForConversation(api.conversationId) ?? "";
        console.log(`[guard] asking approval for ${call.name}: ${reason}`);
        const approved = await requestApproval({
          callId: call.id,
          conversationId: api.conversationId as unknown as number,
          grantKey: key,
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
