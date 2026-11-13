/**
 * What the newest turn is doing. This used to be three independent booleans spread across
 * Transcript (`busy`, `finals.length`, `running tool`) and they disagreed often enough that a
 * running turn looked finished. One union, one derivation, one set of words for the UI.
 */
export type TurnState =
  | { kind: "idle" }
  | { kind: "thinking" }
  | { kind: "tool"; name: string; tail: string; text: string }
  | { kind: "streaming"; text: string }
  | { kind: "settled" };

export function turnState(input: {
  busy: boolean;
  hasAnswer: boolean;
  /** Text the model has produced so far in this turn. */
  text: string;
  tool?: { name: string; tail: string };
}): TurnState {
  // Nothing is running, so a leftover live doc is a ghost: the turn is whatever the record says.
  if (!input.busy) return input.hasAnswer ? { kind: "settled" } : { kind: "idle" };
  if (input.tool !== undefined) return { kind: "tool", name: input.tool.name, tail: input.tool.tail, text: input.text };
  if (input.text.length > 0) return { kind: "streaming", text: input.text };
  // The answer is already on screen; the run is only finishing its bookkeeping.
  if (input.hasAnswer) return { kind: "settled" };
  // Between two tool calls the model is thinking: no tool running, no text yet. This is the state
  // that must never render as nothing.
  return { kind: "thinking" };
}

/** Whether this turn still has work coming. */
export function isLive(state: TurnState): boolean {
  return state.kind === "thinking" || state.kind === "tool" || state.kind === "streaming";
}

/** The tool slot the run is inside right now, with the last line it printed. */
export function runningTool(
  tools: Array<Record<string, unknown>> | undefined,
): { name: string; tail: string } | undefined {
  const running = tools?.find((slot) => slot["status"] === "running");
  if (running === undefined) return undefined;
  const tail = String(running["output"] ?? "")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .pop();
  return { name: String(running["name"] ?? ""), tail: tail ?? "" };
}
