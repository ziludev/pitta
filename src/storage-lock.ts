import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";

/**
 * One writer per storage. The harness has no cross-process lock, so a stray script
 * (or a second launchd instance) opening the same SQLite corrupts the running
 * session — this happened for real. A pid file makes it a loud error instead.
 *
 * A pid alone is not an identity: after a hard kill or a reboot the number comes back
 * attached to something else, and "alive" then blocks every start while launchd retries
 * forever. So a holder only counts when its process is still this program.
 */
export function acquireStorageLock(dbPath: string): void {
  if (process.env.AGENT_ALLOW_CONCURRENT === "1") return;
  const lockPath = join(dirname(dbPath), "agent.owner");
  const holder = takeLock(lockPath);
  if (holder !== undefined) {
    throw new Error(
      `storage ${dbPath} is owned by pid ${holder} (a running agent). ` +
        `Use ./scripts/agentctl stop first, or set AGENT_ALLOW_CONCURRENT=1 to override.`,
    );
  }
  const release = (): void => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      // best effort: a stale lock is recovered by the same checks on the next start
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, release);
  }
}

/** Returns the pid of the agent that holds the lock, or undefined when this process now holds it. */
function takeLock(lockPath: string): number | undefined {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // Exclusive create: two starters that both saw no file cannot both win.
      writeFileSync(lockPath, String(process.pid), { encoding: "utf8", flag: "wx" });
      return undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = readHolder(lockPath);
    if (holder !== undefined && holder !== process.pid && isAgentProcess(holder)) return holder;
    try {
      unlinkSync(lockPath);
    } catch {
      // Another starter removed it first; the next attempt still decides through the create.
    }
  }
  return readHolder(lockPath);
}

function readHolder(lockPath: string): number | undefined {
  try {
    const holder = Number(readFileSync(lockPath, "utf8").trim());
    return Number.isFinite(holder) && holder > 0 ? holder : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `pid` is alive AND still runs this agent — the second half is what a recycled pid fails. */
function isAgentProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  const probe = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  // No ps to ask: assume the worst and refuse, since opening the storage twice corrupts it.
  if (probe.error !== undefined) return true;
  if (probe.status !== 0) return false;
  return looksLikeAgent(probe.stdout ?? "");
}

export function looksLikeAgent(command: string): boolean {
  return command.includes("main.ts") && command.includes("node");
}
