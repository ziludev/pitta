import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { log, logError } from "./log.ts";

const run = promisify(execFile);
const MAX_DIFF_BYTES = 240_000;

export type FileChange = { path: string; status: string; added: number; removed: number };

export type ChangesSnapshot = {
  repo: boolean;
  /** Working tree vs the last commit, as one unified diff. */
  diff: string;
  files: FileChange[];
  truncated: boolean;
  error?: string;
};

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], { timeout: 20_000, maxBuffer: 32 * 1024 * 1024 });
  return stdout;
}

/**
 * A git repo in the workspace makes every agent edit reviewable (and revertible)
 * from the client. An existing repo is never re-initialised: if the workspace
 * points at a real project, its own history is what the user wants to see.
 */
export async function ensureRepo(dir: string): Promise<boolean> {
  try {
    if (existsSync(join(dir, ".git"))) return true;
    await git(dir, ["init", "--quiet"]);
    // Worktrees live inside the repo dir; they must never show up as changes.
    await writeFile(join(dir, ".gitignore"), ".worktrees/\n.DS_Store\n", "utf8");
    await git(dir, ["config", "user.name", "pi-durable-agent"]);
    await git(dir, ["config", "user.email", "agent@localhost"]);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "--quiet", "-m", "workspace: initial snapshot"]);
    log("changes", "initialised workspace repo", { dir });
    return true;
  } catch (error) {
    logError("changes", "could not initialise workspace repo", error);
    return false;
  }
}

const STATUS_LABEL: Record<string, string> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  "?": "untracked",
};

export async function collectChanges(dir: string): Promise<ChangesSnapshot> {
  if (!existsSync(join(dir, ".git"))) {
    return { repo: false, diff: "", files: [], truncated: false };
  }
  try {
    const status = await git(dir, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
    const files: FileChange[] = [];
    const entries = status.split("\0").filter((entry) => entry.length > 0);
    for (const entry of entries) {
      const code = entry.slice(0, 2).trim();
      const path = entry.slice(3);
      const kind = STATUS_LABEL[code.charAt(0)] ?? (code.length === 0 ? "clean" : code);
      files.push({ path, status: kind, added: 0, removed: 0 });
    }

    // numstat gives per-file line counts for the list, the patch gives the body.
    const numstat = await git(dir, ["diff", "HEAD", "--numstat"]).catch(() => "");
    for (const line of numstat.split("\n")) {
      const [added, removed, path] = line.split("\t");
      if (path === undefined) continue;
      const file = files.find((item) => item.path === path);
      if (file !== undefined) {
        file.added = Number(added) || 0;
        file.removed = Number(removed) || 0;
      }
    }

    // Untracked files have no diff, so add them to the index-intent for display.
    let patch = await git(dir, ["diff", "HEAD", "--no-color", "--unified=3"]).catch(() => "");
    const untracked = files.filter((file) => file.status === "untracked").map((file) => file.path);
    for (const path of untracked.slice(0, 20)) {
      const synthetic = await git(dir, ["diff", "--no-index", "--no-color", "--unified=3", "/dev/null", path]).catch(
        (error: { stdout?: string }) => error.stdout ?? "",
      );
      // git diff --no-index exits 1 when files differ, its stdout still holds the patch.
      patch += synthetic;
    }

    const truncated = patch.length > MAX_DIFF_BYTES;
    return {
      repo: true,
      diff: truncated ? patch.slice(0, MAX_DIFF_BYTES) : patch,
      files,
      truncated,
    };
  } catch (error) {
    logError("changes", "could not read workspace changes", error);
    return { repo: true, diff: "", files: [], truncated: false, error: (error as Error).message };
  }
}

/** Commit the workspace as one checkpoint, so the next diff starts clean. */
export async function commitChanges(dir: string, message: string): Promise<string> {
  await git(dir, ["add", "-A"]);
  const status = await git(dir, ["status", "--porcelain"]);
  if (status.trim().length === 0) return "nothing to commit";
  await git(dir, ["commit", "--quiet", "-m", message.slice(0, 200)]);
  const head = (await git(dir, ["rev-parse", "--short", "HEAD"])).trim();
  log("changes", "workspace committed", { head, message: message.slice(0, 60) });
  return head;
}
