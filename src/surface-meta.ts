import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { log } from "./log.ts";

export type SurfaceMeta = {
  /** Owner-set name; empty means "use the first message". */
  title?: string;
  archived?: boolean;
  /** When the surface first appeared, for sorting archived ones. */
  createdAt: number;
};

/**
 * Per-surface state the conversation itself does not carry: a name the owner chose,
 * and whether the chat is archived out of the way. Sessions are created passively
 * (a Feishu group) and actively (the client's new chat), so both need tidying.
 */
export const SurfaceMetaDoc = defineDoc<{ surfaces: Record<string, SurfaceMeta> }>({
  kind: "app.surface-meta",
  version: 1,
  scope: "session",
  initial: () => ({ surfaces: {} }),
  checkpointWhen: () => false,
});

export async function surfaceMeta(
  harness: Harness,
  context: Context,
): Promise<Record<string, SurfaceMeta>> {
  return (await harness.snapshot(SurfaceMetaDoc, context))?.surfaces ?? {};
}

export async function updateSurfaceMeta(
  harness: Harness,
  context: Context,
  surfaceId: string,
  patch: { title?: string | null; archived?: boolean },
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(SurfaceMetaDoc);
    const current = doc.surfaces[surfaceId] ?? { createdAt: Date.now() };
    if (patch.title !== undefined) {
      if (patch.title === null || patch.title.trim().length === 0) delete current.title;
      else current.title = patch.title.trim().slice(0, 60);
    }
    if (patch.archived !== undefined) current.archived = patch.archived;
    doc.surfaces[surfaceId] = current;
  }, context);
  log("surface", "meta updated", { surfaceId, ...patch });
}
