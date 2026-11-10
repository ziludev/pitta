import { log } from "./log.ts";

export type PendingApproval = {
  callId: string;
  tool: string;
  summary: string;
  reason: string;
  surfaceId: string;
  createdAt: number;
  /** Resolves the blocked tool call; wired by whoever owns the channel. */
  resolve: (approved: boolean, by?: string) => void;
};

/**
 * One registry for pending tool approvals, so every surface can see and answer the
 * same request: the Feishu card, the desktop client, or the CLI prompt. Before this,
 * an approval raised while the owner was in the desktop app was invisible and the
 * turn simply hung until the Feishu card timed out.
 */
const pending = new Map<string, PendingApproval>();

export function registerApproval(entry: Omit<PendingApproval, "createdAt">): void {
  pending.set(entry.callId, { ...entry, createdAt: Date.now() });
  log("approval", "registered", { callId: entry.callId.slice(-12), tool: entry.tool, surfaceId: entry.surfaceId });
}

export function listApprovals(): Array<Omit<PendingApproval, "resolve">> {
  return [...pending.values()]
    .sort((a, b) => a.createdAt - b.createdAt)
    .map(({ resolve: _resolve, ...rest }) => rest);
}

export function resolveApproval(callId: string, approved: boolean, by = "unknown"): boolean {
  const entry = pending.get(callId);
  if (entry === undefined) return false;
  pending.delete(callId);
  entry.resolve(approved, by);
  log("approval", "resolved", { callId: callId.slice(-12), approved, by });
  return true;
}

export function dropApproval(callId: string): void {
  pending.delete(callId);
}

export function pendingCount(): number {
  return pending.size;
}
