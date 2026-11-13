import { log } from "./log.ts";

/**
 * A task's terminal state has several authors: the phase that finished the work, the abort hook, a
 * timeout, a shutdown. The Session accepts the first write and refuses the rest with
 * "Task <id> is terminal" — losing that race is normal and the record already says what happened,
 * so it must not surface as a task error. Everything else still throws.
 */
const BENIGN = [/ is terminal$/, / is abort-marked$/, /^Session is closed$/];

export async function settle(task: string, write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!BENIGN.some((pattern) => pattern.test(message))) throw error;
    log("settle", "task was already settled", { task, reason: message });
  }
}
