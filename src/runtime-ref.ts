import type { Harness } from "@earendil-works/pi-durable";

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
