import { log } from "./log.ts";

export type PendingApproval = {
  /** Risk class the caller may grant for the whole conversation. */
  grantKey?: string;
  callId: string;
  tool: string;
  summary: string;
  reason: string;
  surfaceId: string;
  createdAt: number;
  /** Resolves the blocked tool call; wired by whoever owns the channel. */
  resolve: (approved: boolean, by?: string) => void;
  /**
   * What the surface needs to do when the request ends: patch its card, drop its local list.
   * Called once, and for a timeout too — the surface keeps no timer of its own, which is what
   * kept a second copy of "is this still pending" in flight.
   */
  onSettled?: (outcome: { approved: boolean; by: string }) => void;
  /** Deny when nobody answers in time. Armed here so the pending state has one owner. */
  timeoutMs?: number;
};

/**
 * One registry for pending tool approvals, so every surface can see and answer the
 * same request: the Feishu card, the desktop client, or the CLI prompt. Before this,
 * an approval raised while the owner was in the desktop app was invisible and the
 * turn simply hung until the Feishu card timed out.
 */
const pending = new Map<string, PendingApproval>();

/** Conversation each pending call belongs to, so a wait can be attributed to a turn. */
const conversations = new Map<string, number>();

/** The timeout that denies an unanswered request, owned here rather than by each surface. */
const timers = new Map<string, NodeJS.Timeout>();

/**
 * Called when an approval settles, with how long the human took. The host persists it so
 * "waiting on you" can be shown as part of the turn's timeline instead of unexplained time.
 */
type WaitRecorder = (wait: { conversationId?: number; tool: string; start: number; end: number }) => void;
let recordWait: WaitRecorder | undefined;

export function setWaitRecorder(recorder: WaitRecorder | undefined): void {
  recordWait = recorder;
}

function clearTimer(callId: string): void {
  const timer = timers.get(callId);
  if (timer !== undefined) {
    clearTimeout(timer);
    timers.delete(callId);
  }
}

export function registerApproval(
  entry: Omit<PendingApproval, "createdAt"> & { conversationId?: number },
): void {
  pending.set(entry.callId, { ...entry, createdAt: Date.now() });
  if (entry.conversationId !== undefined) conversations.set(entry.callId, entry.conversationId);
  if (entry.timeoutMs !== undefined) {
    timers.set(
      entry.callId,
      setTimeout(() => {
        // Timeout is a denial like any other: it reads the same path, so the surface is told once.
        if (!resolveApproval(entry.callId, false, "timeout")) {
          log("approval", "timed out after it was already answered", { callId: entry.callId.slice(-12) });
        }
      }, entry.timeoutMs),
    );
  }
  log("approval", "registered", { callId: entry.callId.slice(-12), tool: entry.tool, surfaceId: entry.surfaceId });
}

export function listApprovals(): Array<Omit<PendingApproval, "resolve" | "onSettled"> & { conversationId?: number }> {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ resolve: _resolve, onSettled: _onSettled, ...rest }) => ({
      ...rest,
      conversationId: conversations.get(rest.callId),
    }));
}

/** One pending request, without the wiring the registry owns. */
export function getApproval(callId: string): ReturnType<typeof listApprovals>[number] | undefined {
  return listApprovals().find((entry) => entry.callId === callId);
}

export function resolveApproval(callId: string, approved: boolean, by = "unknown"): boolean {
  const entry = pending.get(callId);
  if (entry === undefined) return false;
  // Delete first: two clicks, or a click racing the timeout, must not both resolve the waiter.
  pending.delete(callId);
  const conversationId = conversations.get(callId);
  conversations.delete(callId);
  clearTimer(callId);
  recordWait?.({ conversationId, tool: entry.tool, start: entry.createdAt, end: Date.now() });
  entry.onSettled?.({ approved, by });
  entry.resolve(approved, by);
  log("approval", "resolved", { callId: callId.slice(-12), approved, by });
  return true;
}

export function dropApproval(callId: string): void {
  pending.delete(callId);
  conversations.delete(callId);
  clearTimer(callId);
}

/** Process shutdown: every waiter is told no, no timer survives the process. */
export function dropAllApprovals(): number {
  let dropped = 0;
  for (const [callId, entry] of pending) {
    dropped += 1;
    pending.delete(callId);
    conversations.delete(callId);
    clearTimer(callId);
    entry.resolve(false, "shutdown");
  }
  return dropped;
}

export function pendingCount(): number {
  return pending.size;
}
