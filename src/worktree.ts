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
export async function ensureWorktree(repoRoot: string, conversationId: number): Promise<Worktree | undefined> {
  const target = worktreePaths(repoRoot, conversationId);
  try {
    if (!existsSync(join(repoRoot, ".git"))) return undefined;
    if (existsSync(join(target.dir, ".git"))) return target;

    await mkdir(join(repoRoot, ".worktrees"), { recursive: true });
    const base = (await git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD";

    // Branch may already exist from an earlier session: attach instead of creating.
    const known = await git(repoRoot, ["branch", "--list", target.branch]).catch(() => "");
    const args = known.trim().length > 0
      ? ["worktree", "add", target.dir, target.branch]
      : ["worktree", "add", "-b", target.branch, target.dir, base];
    await git(repoRoot, args);
    log("worktree", "created", { conversationId, dir: target.dir, branch: target.branch, base });
    return target;
  } catch (error) {
    logError("worktree", `could not create worktree for conversation ${conversationId}`, error);
    return undefined;
  }
}

/** Removes a worktree directory and its branch (the branch is deleted only when merged). */
export async function removeWorktree(repoRoot: string, conversationId: number): Promise<void> {
  const target = worktreePaths(repoRoot, conversationId);
  try {
    await git(repoRoot, ["worktree", "remove", "--force", target.dir]);
    await git(repoRoot, ["worktree", "prune"]);
    await git(repoRoot, ["branch", "-D", target.branch]);
    log("worktree", "removed", { conversationId, branch: target.branch });
  } catch (error) {
    logError("worktree", `could not remove worktree ${conversationId}`, error);
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
