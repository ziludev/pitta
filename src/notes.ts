import type { Context } from "@earendil-works/chord/context";
import type { Conversation } from "@earendil-works/pi-durable";
import { logError } from "./log.ts";

/**
 * A line in the transcript that the model never sees.
 *
 * pi-durable distinguishes a display-only write (a kind and data, no messages) from input: it is
 * appended, settled at once, and kept out of the context the model reads. That is exactly what a
 * restart, a correction or an automatic continuation is — something the owner should see in the
 * client, and nothing the model should pay for on the next request.
 */
export const NOTE_KIND = "app.note";

export async function note(conversation: Conversation, context: Context, text: string): Promise<void> {
  await conversation
    .submit({ type: "write", entry: { kind: NOTE_KIND, data: { text } } }, context)
    .catch((error: unknown) => logError("note", "could not write a transcript note", error));
}
