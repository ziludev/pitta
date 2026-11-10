/**
 * Outbound plumbing the extensions need but cannot own: sending a message to a surface
 * (Feishu chat) and asking a human to approve a tool call. The bridge installs both at
 * boot; the CLI installs a stdout/stdin version. Failures fail closed.
 */
export type Notifier = (surfaceId: string, text: string) => Promise<void>;

let notifier: Notifier | undefined;

export function setNotifier(next: Notifier | undefined): void {
  notifier = next;
}

export async function notify(surfaceId: string, text: string): Promise<void> {
  if (notifier === undefined) {
    console.log(`[notify:${surfaceId}] ${text}`);
    return;
  }
  await notifier(surfaceId, text);
}

export type ApprovalRequest = {
  /** Tool call id; unique per call and used as the durable memo key. */
  callId: string;
  /** Conversation the blocked call belongs to, so the wait can be charted on its turn. */
  conversationId: number;
  tool: string;
  /** One-line summary of what the model is about to do. */
  summary: string;
  /** Why it needs a human. */
  reason: string;
  surfaceId: string;
  timeoutMs: number;
};

export type ApprovalDecider = (request: ApprovalRequest) => Promise<boolean>;

let decider: ApprovalDecider | undefined;

export function setApprovalDecider(next: ApprovalDecider | undefined): void {
  decider = next;
}

export async function requestApproval(request: ApprovalRequest): Promise<boolean> {
  if (decider === undefined) {
    // No decider means no human to ask: deny rather than silently run a risky call.
    console.warn(`[approval] no decider configured, denying ${request.tool}`);
    return false;
  }
  return decider(request);
}

/**
 * conversation -> surface map, kept in memory only. The durable copy lives in the
 * session document `app.chats`; this is the fast lookup the extensions use to answer
 * "where do I send this?" without touching storage in a hot path.
 */
const surfaces = new Map<number, string>();

export function rememberSurface(conversationId: number, surfaceId: string): void {
  surfaces.set(conversationId, surfaceId);
}

export function surfaceForConversation(conversationId: number): string | undefined {
  return surfaces.get(conversationId);
}
