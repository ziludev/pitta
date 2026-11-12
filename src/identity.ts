import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Models } from "@earendil-works/pi-ai/models";
import type { Context } from "@earendil-works/chord/context";
import { config } from "./config.ts";
import { log, logError } from "./log.ts";

/**
 * The name the agent chose for itself, kept so it survives restarts and every prompt can use it.
 *
 * A bot that answers to the app name in the Feishu console ("alex's agent") reads like a product,
 * not a colleague; the agent picks a short name once, and `personal.ts` tells it "你叫 X".
 */
export const IdentityDoc = defineDoc<{ name?: string; chosenAt?: number }>({
  kind: "app.identity",
  version: 1,
  scope: "session",
  initial: () => ({}),
  checkpointWhen: () => false,
});

const PROMPT =
  "给你自己起一个名字：两个汉字或一个简短英文单词，好叫、专业、不装可爱，" +
  "不要带引号、句号或解释。只回答名字本身。";

/** A model answers in sentences; a name is one short token without punctuation. */
export function cleanName(raw: string): string {
  const line = (raw.trim().split(/\r?\n/)[0] ?? "").trim();
  const cut = line.split(/[。，、；：！？,.;:!?\s]+/)[0] ?? "";
  // A model often opens with the sentence, not the name.
  const name = cut
    .replace(/^["'“”「」『』*#\-]+|["'“”「」『』*#。.!！]+$/g, "")
    .replace(/^(?:我叫|我的名字是|名字是|叫我|i am|i'm|call me|my name is)\s*/i, "")
    .trim();
  return name.length === 0 || name.length > 16 ? "" : name;
}

export async function agentName(harness: Harness, context: Context): Promise<string | undefined> {
  const doc = await harness.snapshot(IdentityDoc, context).catch(() => undefined);
  return doc?.name !== undefined && doc.name.length > 0 ? doc.name : undefined;
}

/** Picks and stores a name the first time; a no-op afterwards, and never fatal. */
export async function chooseName(harness: Harness, models: Models, context: Context): Promise<string | undefined> {
  const existing = await agentName(harness, context);
  if (existing !== undefined) return existing;
  const model = models.getModel(config.model.provider, config.model.modelId);
  if (model === undefined) return undefined;
  const answer = await models
    .complete(model, {
      systemPrompt: PROMPT,
      messages: [{ role: "user", content: "你叫什么名字？", timestamp: Date.now() }],
    })
    .catch((error: unknown) => {
      logError("identity", "could not pick a name", error);
      return undefined;
    });
  if (answer === undefined) return undefined;
  const name = cleanName(
    (answer.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join(""),
  );
  if (name.length === 0) return undefined;
  await harness.commit(async (tx) => {
    const doc = await tx.doc(IdentityDoc);
    doc.name = name;
    doc.chosenAt = Date.now();
  }, context);
  log("identity", "named itself", { name });
  return name;
}
