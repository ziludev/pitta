import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { log, logError } from "./log.ts";

const run = promisify(execFile);

async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", dir, ...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export type CommitInfo = {
  hash: string;
  short: string;
  date: string;
  subject: string;
  files: number;
  added: number;
  removed: number;
};

export type BranchInfo = { name: string; current: boolean; upstream?: string; track?: string };

export type RemoteInfo = {
  url?: string;
  /** github | gitlab | other | none */
  kind: "github" | "gitlab" | "other" | "none";
  webUrl?: string;
};

/** The branch the project's main checkout is on: the base for a chat's work. */
export async function baseBranch(projectPath: string): Promise<string> {
  try {
    return (await git(projectPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim() || "HEAD";
  } catch {
    return "HEAD";
  }
}

/** Commits on the chat's branch that are not on the project's base branch. */
export async function commitLog(
  worktreePath: string,
  projectPath: string,
  limit = 20,
): Promise<CommitInfo[]> {
  const base = await baseBranch(projectPath);
  const raw = await git(worktreePath, [
    "log",
    `--max-count=${limit}`,
    "--shortstat",
    "--format=%x01%H%x02%h%x02%aI%x02%s",
    `${base}..HEAD`,
  ]).catch(() => "");
  if (raw.trim().length === 0) return [];

  const commits: CommitInfo[] = [];
  for (const block of raw.split("\x01").filter((piece) => piece.trim().length > 0)) {
    const [head, ...rest] = block.split("\n");
    const [hash, short, date, subject] = (head ?? "").split("\x02");
    if (hash === undefined) continue;
    const stat = rest.join(" ").trim();
    const files = /(\d+) files? changed/.exec(stat);
    const added = /(\d+) insertions?/.exec(stat);
    const removed = /(\d+) deletions?/.exec(stat);
    commits.push({
      hash,
      short: short ?? hash.slice(0, 7),
      date: date ?? "",
      subject: subject ?? "",
      files: files === null ? 0 : Number(files[1]),
      added: added === null ? 0 : Number(added[1]),
      removed: removed === null ? 0 : Number(removed[1]),
    });
  }
  return commits;
}

/** One commit's patch, for the inline diff view. */
export async function commitDiff(worktreePath: string, hash: string): Promise<string> {
  return git(worktreePath, ["show", "--no-color", "--format=", "--unified=3", hash]).catch(() => "");
}

export async function branches(projectPath: string): Promise<BranchInfo[]> {
  const raw = await git(projectPath, [
    "for-each-ref",
    "--format=%(refname:short)\t%(HEAD)\t%(upstream:short)\t%(upstream:track)",
    "refs/heads",
  ]).catch(() => "");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const [name, head, upstream, track] = line.split("\t");
      return {
        name: name ?? "",
        current: (head ?? "").trim() === "*",
        upstream: upstream === undefined || upstream === "" ? undefined : upstream,
        track: track === undefined || track === "" ? undefined : track.replace(/^\[|\]$/g, ""),
      };
    });
}

export async function remoteInfo(projectPath: string): Promise<RemoteInfo> {
  const url = await git(projectPath, ["remote", "get-url", "origin"]).then((out) => out.trim()).catch(() => "");
  if (url.length === 0) return { kind: "none" };
  const web = url
    .replace(/^git@([^:]+):/, "https://$1/")
    .replace(/^ssh:\/\/git@([^/]+)\//, "https://$1/")
    .replace(/\.git$/, "");
  const kind: RemoteInfo["kind"] = web.includes("github.com")
    ? "github"
    : web.includes("gitlab")
      ? "gitlab"
      : "other";
  return { url, kind, webUrl: web };
}

/** The page a human opens to create a PR (GitHub) or MR (GitLab) for this branch. */
export function compareUrl(remote: RemoteInfo, base: string, branch: string): string | undefined {
  if (remote.webUrl === undefined) return undefined;
  if (remote.kind === "github") return `${remote.webUrl}/compare/${base}...${branch}?expand=1`;
  if (remote.kind === "gitlab") {
    return `${remote.webUrl}/-/merge_requests/new?merge_request[source_branch]=${branch}&merge_request[target_branch]=${base}`;
  }
  return undefined;
}

export type PushResult =
  | { status: "pushed"; branch: string; remote: string; compareUrl?: string }
  | { status: "dry-run"; branch: string; remote: string; output: string }
  | { status: "no-remote" }
  | { status: "error"; message: string };

/** Pushes the chat's branch to origin. Refuses to force; a dry run reports first. */
export async function pushBranch(
  worktreePath: string,
  projectPath: string,
  branch: string,
  options: { dryRun?: boolean } = {},
): Promise<PushResult> {
  const remote = await remoteInfo(projectPath);
  if (remote.kind === "none") return { status: "no-remote" };
  try {
    const args = ["push", "-u", "origin", `HEAD:refs/heads/${branch}`];
    if (options.dryRun === true) args.splice(1, 0, "--dry-run");
    const { stdout, stderr } = await run("git", ["-C", worktreePath, ...args], {
      timeout: 120_000,
      maxBuffer: 8 * 1024 * 1024,
    }).then(
      (result) => ({ stdout: result.stdout, stderr: result.stderr }),
      (error: { stdout?: string; stderr?: string; message: string }) => {
        throw new Error((error.stderr ?? error.stdout ?? error.message).trim().slice(0, 500));
      },
    );
    if (options.dryRun === true) {
      return { status: "dry-run", branch, remote: remote.url ?? "", output: `${stdout}${stderr}`.trim() };
    }
    log("git", "pushed", { branch, remote: remote.url });
    return {
      status: "pushed",
      branch,
      remote: remote.url ?? "",
      compareUrl: compareUrl(remote, await baseBranch(projectPath), branch),
    };
  } catch (error) {
    logError("git", "push failed", error);
    return { status: "error", message: (error as Error).message };
  }
}
