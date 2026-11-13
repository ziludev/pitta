import { isAbsolute, relative, resolve } from "node:path";
import { defineExtension, hook, ToolTask } from "@earendil-works/pi-durable";
import { config } from "./config.ts";
import { requestApproval, surfaceForConversation } from "./channel.ts";
import { hasGrant } from "./grants.ts";
import { ChatPolicy, guestRoots } from "./access.ts";
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
 * tool runs, because a prompt does not stop `cat .env`. A group member investigating a problem
 * needs the shell (git log, grep, a select against the test db), so bash is on the surface with
 * a command-level allowlist under it — see guestShellBlockReason.
 */
const GUEST_TOOLS = new Set(["read", "bash", "skill", "recall", "remind", "logs_query", "project_search"]);

/** Commands a guest may run at all. Everything absent here is refused before it starts. */
const GUEST_SHELL_COMMANDS = new Set([
  "ls", "cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "rg", "find", "tree", "file",
  "stat", "du", "df", "pwd", "echo", "date", "which", "basename", "dirname", "realpath",
  "sort", "uniq", "cut", "tr", "jq", "diff", "comm", "column", "xxd", "strings", "test",
  "git", "psql", "curl", "dig", "nslookup", "host", "ping", "nc", "sleep", "true",
]);

/** `git log` is investigation; `git checkout` is a change. Only these subcommands pass. */
const GUEST_GIT_SUBCOMMANDS = new Set([
  "log", "show", "diff", "status", "blame", "grep", "ls-files", "rev-parse", "describe",
  "remote", "shortlog", "cat-file", "show-ref", "for-each-ref", "whatchanged", "count-objects",
  "ls-tree", "name-rev", "merge-base", "diff-tree",
]);

/** Shapes that turn a read into a write, or into a second program we did not vet. */
const GUEST_SHELL_DENY: Array<[RegExp, string]> = [
  [/\$\(|`/, "子命令替换"],
  [/(^|[^>])>{1,2}(?![>=])/, "重定向写文件"],
  [/\btee\b/, "写文件"],
  [/\bsudo\b/, "提权执行"],
  [/\b(xargs|eval|source|exec|env)\b/, "间接执行"],
  [/\bfind\b[^|;&\n]*\s(-delete|-exec|-execdir|-ok|-fprint\S*|-fls)\b/, "批量删除/执行/写文件"],
  [/\b(curl|wget)\b[^|;&\n]*\s(-o|-O|-d|-F|-T|-X|--data\S*|--upload-file|--output)\b/, "下载落盘或发起写请求"],
  [/--output[=\s]/, "写文件"],
  [/\b(docker|kubectl|aws|gcloud|gsutil|gh|npm|npx|yarn|pnpm|pip|brew|ssh|scp|rsync)\b/, "外部系统的写操作"],
  [/\b(rm|mv|cp|chmod|chown|mkdir|touch|ln|dd|truncate|kill|pkill)\b/, "改文件或进程"],
];

/** psql is on the list for `select`; one update and the "read-only" claim is a lie. */
const GUEST_SQL_WRITE = /\b(insert|update|delete|drop|alter|create|truncate|grant|revoke|copy|vacuum)\b/i;
const GUEST_SQL_READ = /^\s*(select|with|explain|show|table|values|\\d)/i;

/** A token that reads as a filesystem path, so it can be checked against the guest roots. */
function looksLikePath(token: string): boolean {
  return token.startsWith("/") || token.startsWith("./") || token.startsWith("../") || token.startsWith("~/");
}

/** Command text with quoted arguments blanked, so `where a > 1` is not read as a redirect. */
function withoutQuoted(text: string): string {
  return text.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/**
 * Why a guest shell call is refused, or undefined when it may run. The rule is a positive list
 * of read-only commands plus per-command checks, not a blacklist of dangerous strings: a
 * blacklist is one flag away from `git -c core.pager='sh -c ...' log`.
 */
export function guestShellBlockReason(command: string, roots: readonly string[] = [config.workspace]): string | undefined {
  const raw = command.trim();
  if (raw.length === 0) return "这个群是 guest 模式：命令为空。";
  const bare = withoutQuoted(raw);
  for (const [pattern, why] of GUEST_SHELL_DENY) {
    if (pattern.test(bare)) return `这个群是 guest 模式：${why}（这里只允许只读查证）。`;
  }
  for (const segment of raw.split(/&&|\|\||;|\|/).map((part) => part.trim()).filter((part) => part.length > 0)) {
    const tokens = segment.split(/\s+/);
    const name = tokens[0] ?? "";
    if (!GUEST_SHELL_COMMANDS.has(name)) {
      return `这个群是 guest 模式：不能执行 ${name}（只允许只读查证：git log / grep / psql select 这类）。`;
    }
    if (name === "git") {
      // `git -C <path> log` and `git --no-pager show` are still reads; `-c` is not, because it
      // sets config and config can name a program to run.
      let sub = 1;
      while (sub < tokens.length && tokens[sub]?.startsWith("-")) {
        if (tokens[sub] === "-C" || tokens[sub] === "--git-dir" || tokens[sub] === "--work-tree") sub += 2;
        else if (tokens[sub] === "--no-pager" || tokens[sub] === "-P") sub += 1;
        else return `这个群是 guest 模式：git ${tokens[sub] ?? ""} 不接受（只允许 git log / show / diff / grep 这类只读查询）。`;
      }
      if (!GUEST_GIT_SUBCOMMANDS.has(tokens[sub] ?? "")) {
        return `这个群是 guest 模式：git ${tokens[sub] ?? ""} 会改仓库，只允许 git log / show / diff / grep 这类。`;
      }
    }
    if (name === "psql") {
      const marker = segment.search(/\s-c\s/);
      const sql = marker >= 0 ? segment.slice(marker + 3) : segment;
      if (GUEST_SQL_WRITE.test(withoutQuoted(sql)) || !GUEST_SQL_READ.test(sql.replace(/^\s*['"]?/, ""))) {
        return "这个群是 guest 模式：psql 只允许查（select / show / \\d），不允许写。";
      }
    }
    for (const token of tokens) {
      const cleaned = token.replace(/^['"]|['"]$/g, "");
      if (!looksLikePath(cleaned)) continue;
      if (outsideRoots(cleaned, roots) || GUEST_DENIED_PATHS.some((pattern) => pattern.test(cleaned))) {
        return `这个群是 guest 模式：不能碰 ${cleaned}（可读范围之外或敏感文件）。`;
      }
    }
  }
  return undefined;
}

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
    return `这个群是 guest 模式：不能用 ${tool}（这里只读查证：read / project_search / logs_query / 只读 bash）。`;
  }
  if (tool === "bash") {
    return guestShellBlockReason(typeof args["command"] === "string" ? args["command"] : "", roots);
  }
  const path = typeof args["path"] === "string" ? args["path"] : "";
  if (path.length > 0 && (outsideRoots(path, roots) || GUEST_DENIED_PATHS.some((pattern) => pattern.test(path)))) {
    return `这个群是 guest 模式：不能读 ${path}（可读范围之外或敏感文件）。`;
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
          const roots = await guestRoots(api, api.conversationId as unknown as number, context);
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
