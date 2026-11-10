import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, logError } from "./log.ts";

const run = promisify(execFile);

export type Worktree = { dir: string; branch: string };

/**
 * One git worktree and branch per conversation: parallel sessions stop stepping on
 * each other, and the main tree stays clean until something is merged. This is the
 * isolation model ThinkRail uses (a workspace is a worktree).
 */
export function worktreePaths(repoRoot: string, conversationId: number): Worktree {
  return {
    dir: join(repoRoot, ".worktrees", `conv-${conversationId}`),
    branch: `agent/conv-${conversationId}`,
  };
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoRoot, ...args], { timeout: 30_000, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

/** Creates the worktree on first use; an existing one is reused as is. */
export async function ensureWorktree(
  repoRoot: string,
  conversationId: number,
  base?: string,
): Promise<Worktree | undefined> {
  const target = worktreePaths(repoRoot, conversationId);
  try {
    if (!existsSync(join(repoRoot, ".git"))) return undefined;
    if (existsSync(join(target.dir, ".git"))) return target;

    await mkdir(join(repoRoot, ".worktrees"), { recursive: true });
    const from = base ?? ((await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD");

    // Branch may already exist from an earlier session: attach instead of creating.
    const known = await git(repoRoot, ["branch", "--list", target.branch]).catch(() => "");
    const args = known.trim().length > 0
      ? ["worktree", "add", target.dir, target.branch]
      : ["worktree", "add", "-b", target.branch, target.dir, from];
    await git(repoRoot, args);
    log("worktree", "created", { conversationId, dir: target.dir, branch: target.branch, from });
    return target;
  } catch (error) {
    logError("worktree", `could not create worktree for conversation ${conversationId}`, error);
    return undefined;
  }
}

export type RemoveResult =
  | { status: "removed"; branch: string }
  | { status: "unmerged"; branch: string; commits: number }
  | { status: "absent"; branch: string }
  | { status: "error"; message: string };

/**
 * Drops a conversation's checkout. Refuses while the branch still has commits that
 * are not on the main branch: that work only exists in this worktree.
 */
export async function removeWorktree(
  repoRoot: string,
  conversationId: number,
  options: { force?: boolean; base?: string } = {},
): Promise<RemoveResult> {
  const target = worktreePaths(repoRoot, conversationId);
  try {
    if (!existsSync(target.dir)) return { status: "absent", branch: target.branch };
    const base = options.base ?? (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const ahead = Number((await git(repoRoot, ["rev-list", "--count", `${base}..${target.branch}`])).trim()) || 0;
    if (ahead > 0 && options.force !== true) {
      log("worktree", "refusing to remove unmerged worktree", { conversationId, branch: target.branch, ahead });
      return { status: "unmerged", branch: target.branch, commits: ahead };
    }
    await git(repoRoot, ["worktree", "remove", "--force", target.dir]);
    await git(repoRoot, ["worktree", "prune"]);
    await git(repoRoot, ["branch", "-D", target.branch]).catch(() => "");
    log("worktree", "removed", { conversationId, branch: target.branch, discardedCommits: ahead });
    return { status: "removed", branch: target.branch };
  } catch (error) {
    logError("worktree", `could not remove worktree ${conversationId}`, error);
    return { status: "error", message: (error as Error).message };
  }
}

export type WorktreeInfo = { conversationId: number; branch: string; dir: string; dirty: number };

export async function listWorktrees(repoRoot: string): Promise<WorktreeInfo[]> {
  try {
    const raw = await git(repoRoot, ["worktree", "list", "--porcelain"]);
    const entries: WorktreeInfo[] = [];
    let current: { dir?: string; branch?: string } = {};
    for (const line of raw.split("\n")) {
      if (line.startsWith("worktree ")) current.dir = line.slice(9);
      else if (line.startsWith("branch ")) current.branch = line.slice(7).replace("refs/heads/", "");
      else if (line.trim() === "" && current.dir !== undefined) {
        const match = /conv-(\d+)$/.exec(current.branch ?? current.dir);
        if (match !== null) {
          entries.push({
            conversationId: Number(match[1]),
            branch: current.branch ?? "",
            dir: current.dir,
            dirty: 0,
          });
        }
        current = {};
      }
    }
    return entries;
  } catch (error) {
    logError("worktree", "could not list worktrees", error);
    return [];
  }
}

export type MergeResult =
  | { status: "merged"; branch: string; base: string; commits: number }
  | { status: "up-to-date"; branch: string; base: string }
  | { status: "dirty"; branch: string; files: string[] }
  | { status: "main-dirty"; base: string; files: string[] }
  | { status: "conflict"; branch: string; base: string; conflicts: string[] }
  | { status: "error"; message: string };

/**
 * Merges a conversation's branch back into the main worktree's branch.
 * Refuses instead of guessing: both sides must be committed, and a conflict aborts
 * the merge and comes back as data so the agent can be asked to resolve it.
 */
export async function mergeWorktree(
  repoRoot: string,
  conversationId: number,
  baseOverride?: string,
): Promise<MergeResult> {
  const { dir, branch } = worktreePaths(repoRoot, conversationId);
  try {
    const base = baseOverride ?? (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    if (branch === base) return { status: "up-to-date", branch, base };

    const worktreeDirty = (await git(dir, ["status", "--porcelain"])).trim();
    if (worktreeDirty.length > 0) {
      return { status: "dirty", branch, files: worktreeDirty.split("\n").map((line) => line.slice(3)) };
    }

    const ahead = Number((await git(repoRoot, ["rev-list", "--count", `${base}..${branch}`])).trim());
    if (!Number.isFinite(ahead) || ahead === 0) return { status: "up-to-date", branch, base };

    const mainDirty = (await git(repoRoot, ["status", "--porcelain"])).trim();
    if (mainDirty.length > 0) {
      return {
        status: "main-dirty",
        base,
        files: mainDirty.split("\n").map((line) => line.slice(3)),
      };
    }

    try {
      await git(repoRoot, ["merge", "--no-ff", "-m", `merge ${branch} into ${base}`, branch]);
      log("worktree", "merged", { conversationId, branch, base, commits: ahead });
      return { status: "merged", branch, base, commits: ahead };
    } catch (error) {
      const unmerged = await git(repoRoot, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "");
      await git(repoRoot, ["merge", "--abort"]).catch(() => {});
      const conflicts = unmerged
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      if (conflicts.length > 0) {
        log("worktree", "merge conflicted", { conversationId, branch, base, conflicts });
        return { status: "conflict", branch, base, conflicts };
      }
      return { status: "error", message: (error as Error).message };
    }
  } catch (error) {
    logError("worktree", `merge failed for conversation ${conversationId}`, error);
    return { status: "error", message: (error as Error).message };
  }
}
