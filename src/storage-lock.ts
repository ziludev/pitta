import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * One writer per storage. The harness has no cross-process lock, so a stray script
 * (or a second launchd instance) opening the same SQLite corrupts the running
 * session — this happened for real. A pid file makes it a loud error instead.
 */
export function acquireStorageLock(dbPath: string): void {
  if (process.env.AGENT_ALLOW_CONCURRENT === "1") return;
  const lockPath = join(dirname(dbPath), "agent.owner");
  if (existsSync(lockPath)) {
    const holder = Number(readFileSync(lockPath, "utf8").trim());
    if (Number.isFinite(holder) && holder !== process.pid && isAlive(holder)) {
      throw new Error(
        `storage ${dbPath} is owned by pid ${holder} (a running agent). ` +
          `Use ./scripts/agentctl stop first, or set AGENT_ALLOW_CONCURRENT=1 to override.`,
      );
    }
  }
  writeFileSync(lockPath, String(process.pid), "utf8");
  const release = (): void => {
    try {
      if (existsSync(lockPath) && readFileSync(lockPath, "utf8").trim() === String(process.pid)) {
        unlinkSync(lockPath);
      }
    } catch {
      // best effort: a stale lock is recovered by the pid liveness check
    }
  };
  process.once("exit", release);
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, release);
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
