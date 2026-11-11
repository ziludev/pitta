import type { Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";

/**
 * The harness handle, for tools that need session-level operations the tool API
 * deliberately does not expose (inspecting live tasks, aborting one).
 */
let harness: Harness | undefined;

export function setHarnessRef(next: Harness): void {
  harness = next;
}

export function getHarness(): Harness | undefined {
  return harness;
}

/** The session context, so a hook can write a session doc (audit) without owning a turn. */
let sessionContext: Context | undefined;

export function setSessionContext(next: Context): void {
  sessionContext = next;
}

export function getSessionContext(): Context | undefined {
  return sessionContext;
}

/** The session runtime (projects, git, conversations), for tools that need host services. */
type Runtime = Awaited<ReturnType<typeof import("./harness.ts").openRuntime>>;
let runtime: Runtime | undefined;

export function setRuntimeRef(next: Runtime): void {
  runtime = next;
}

export function getRuntime(): Runtime | undefined {
  return runtime;
}
