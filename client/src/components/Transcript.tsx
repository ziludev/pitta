import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Copy, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { Agent } from "@/mygo";
import { Images } from "@/components/Images";
import { tr } from "@/i18n";
import type { Entry } from "@/lib/api";
import { Markdown } from "@/lib/markdown";
import { StepRail, TurnDivider, partsOf, textOf, useElapsed, duration } from "@/components/TurnRail";
import { clockOf, entryText, groupTurns } from "@/lib/turns";
import { Spinner } from "@/components/ui/spinner";
import { useStore } from "@/store";







/** Copy / resend / edit on hover. Regenerating in place is not possible: resending the
 * same input is the honest equivalent, and it keeps the transcript truthful. */
function MessageActions({ text, onRetry }: { text: string; onRetry?: () => void }) {
  const { lang, setComposerDraft, submit } = useStore();
  const copy = (): void => {
    void navigator.clipboard?.writeText(text);
    toast(tr(lang, "copied"));
  };
  return (
    <div className="flex gap-0.5 opacity-0 transition group-hover:opacity-100">
      <button onClick={copy} title={tr(lang, "copy")} className="rounded p-1 text-muted-foreground hover:text-foreground">
        <Copy className="size-3" />
      </button>
      <button
        onClick={() => setComposerDraft(text)}
        title={tr(lang, "edit")}
        className="rounded p-1 text-muted-foreground hover:text-foreground"
      >
        <Pencil className="size-3" />
      </button>
      {onRetry === undefined ? null : (
        <button onClick={onRetry} title={tr(lang, "retry")} className="rounded p-1 text-muted-foreground hover:text-foreground">
          <RotateCcw className="size-3" />
        </button>
      )}
    </div>
  );
}

function UserBubble({ entry, onRetry }: { entry: Entry; onRetry?: () => void }) {
  const { lang, convQuery } = useStore();
  const parts = partsOf(entry.model);
  const images = parts
    .filter((part) => part["type"] === "image")
    .map((part) => ({ data: String(part["data"] ?? ""), mimeType: String(part["mimeType"] ?? "image/png") }))
    .filter((image) => image.data.length > 0);
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="group flex items-start justify-end gap-1">
      <div className="mt-1 shrink-0">
        <MessageActions text={textOf(parts)} onRetry={onRetry} />
      </div>
      <div className="max-w-[86%] rounded-xl rounded-br-sm border border-primary/25 bg-primary/12 px-3 py-2 text-[13px] leading-relaxed">
        {textOf(parts).length > 0 ? <Markdown text={textOf(parts)} highlight={convQuery} /> : null}
        {images.length > 0 ? (
          <div className={textOf(parts).length > 0 ? "mt-1.5" : ""}>
            <Images images={images} />
          </div>
        ) : null}
      </div>
    </motion.div>
  );
}

function AnswerBubble({ entry, retryText }: { entry: Entry; retryText?: string }) {
  const convQuery = useStore((state) => state.convQuery);
  const { lang, submit } = useStore();
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="group flex max-w-[92%] items-start gap-1">
      <div className="rounded-xl rounded-bl-sm border border-border bg-card/70 px-3 py-2 text-[13px] leading-relaxed">
        <Markdown text={textOf(partsOf(entry.model))} highlight={convQuery} />
      </div>
      <div className="mt-1 shrink-0">
        <MessageActions
          text={textOf(partsOf(entry.model))}
          onRetry={
            retryText === undefined
              ? undefined
              : () => void submit(retryText, "followUp").then(() => toast(tr(lang, "resent")))
          }
        />
      </div>
    </motion.div>
  );
}

function FeatureReport({ entry }: { entry: Entry }) {
  const { lang, convQuery } = useStore();
  const payload = (entry.data ?? {}) as { text?: string };
  return (
    <div className="max-w-[92%] rounded-lg border border-border bg-card/60 p-2.5">
      <div className="mb-1 text-[11px] text-muted-foreground">🧩 {tr(lang, "featureReport")}</div>
      <div className="text-[13px] leading-relaxed">
        <Markdown text={payload.text ?? ""} highlight={convQuery} />
      </div>
    </div>
  );
}

/**
 * A line the agent wrote for the owner, not for the model: a restart, a correction, a run that
 * continued itself past the step limit. It reads as a transcript mark, not as an answer.
 */
function NoteLine({ entry }: { entry: Entry }) {
  const text = String((entry.data as { text?: string } | null)?.text ?? "");
  if (text.length === 0) return null;
  return (
    <div className="flex items-center gap-2 py-0.5 text-[10.5px] text-muted-foreground/70" data-entry={entry.id}>
      <span className="h-px flex-1 bg-border/50" />
      <span className="shrink-0">{text}</span>
      <span className="h-px flex-1 bg-border/50" />
    </div>
  );
}

function LiveBlock({ start }: { start?: number }) {
  const { live, busy, lang } = useStore();
  // Ticks only while the model is between tool calls, where nothing else moves.
  const spent = useElapsed(busy ? start : undefined);
  const elapsedText = spent === undefined || spent < 1_000 ? null : (
    <span className="text-muted-foreground">{duration(spent)}</span>
  );
  if (live === undefined) return null;
  const tools = Array.isArray(live.tools) ? live.tools : [];
  const running = tools.find((slot) => slot["status"] === "running");
  const partial = textOf(partsOf(live.generation?.message));
  const tail = running
    ? (String(running["output"] ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .pop() ?? "")
    : "";
  // Between two tool calls the model is thinking: no tool is running and no text has arrived yet.
  // Rendering nothing there is what made a live turn look stopped.
  const waiting = running === undefined && partial.length === 0 && busy;
  if (!waiting && running === undefined && partial.length === 0) return null;
  return (
    <motion.div initial={{ opacity: 0.7 }} animate={{ opacity: 1 }} className="flex max-w-[92%] flex-col gap-1.5">
      {waiting || running !== undefined ? (
        <span className="flex w-fit items-center gap-1.5 rounded-full border border-primary/40 px-2 py-0.5 font-mono text-[10px] text-primary">
          <Spinner size={10} />
          {running === undefined ? `${tr(lang, "thinking")}…` : String(running["name"] ?? "")}
          {waiting ? elapsedText : null}
        </span>
      ) : null}
      {partial.length > 0 ? (
        <div className="rounded-xl rounded-bl-sm border border-dashed border-border bg-card/50 px-3 py-2 text-[13px] leading-relaxed">
          <Markdown text={partial} />
        </div>
      ) : null}
      {tail.length > 0 ? <div className="truncate text-[10px] text-muted-foreground">{tail.slice(0, 160)}</div> : null}
    </motion.div>
  );
}

export function Transcript() {
  const { entries, focusEntry, lang, convQuery, setConvMatches, submit, approvalWaits, usage, busy } = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastFocus = useRef<number | undefined>(undefined);
  /** Entry id of the newest answer we already notified about. */
  const notified = useRef<number | undefined>(undefined);
  const seenCount = useRef(0);
  const turns = useMemo(() => groupTurns(entries, approvalWaits), [entries, approvalWaits]);
  // The newest turn has no answer yet and the conversation is running: that turn is live, and every
  // line under it must look live instead of settled.
  const liveTurn = turns[turns.length - 1];
  const running = busy && liveTurn !== undefined && liveTurn.finals.length === 0;
  // Execution time of the loaded turns (idle between turns excluded): "why is this slow"
  // starts with knowing how much of the wall clock the agent actually spent.
  const totalMs = useMemo(
    () => turns.reduce((sum, turn) => sum + (turn.stats.ms ?? 0), 0),
    [turns],
  );

  // In-conversation search: matches are cheap here, the whole window is in memory.
  useEffect(() => {
    const needle = convQuery.trim().toLowerCase();
    if (needle.length < 2) {
      setConvMatches([]);
      return;
    }
    setConvMatches(entries.filter((entry) => entryText(entry).toLowerCase().includes(needle)).map((entry) => entry.id));
  }, [convQuery, entries, setConvMatches]);

  useEffect(() => {
    const box = boxRef.current;
    const grew = entries.length - seenCount.current;
    seenCount.current = entries.length;
    if (grew <= 0) return;
    if (stick) box !== null && (box.scrollTop = box.scrollHeight);
    else setUnseen((count) => count + grew);
  }, [entries, stick]);

  // A finished answer should reach the owner when the window is in the background.
  useEffect(() => {
    if (!document.hidden) return;
    const answer = [...entries].reverse().find((entry) => entry.kind === "pi.assistant");
    if (answer === undefined || notified.current === answer.id) return;
    notified.current = answer.id;
    const text = textOf(partsOf(answer.model)).replace(/\s+/g, " ").slice(0, 120);
    if (text.length === 0) return;
    void Agent.notify("Agent · 回答完成", text).catch(() => {});
  }, [entries]);

  // ?entry=<id> and search hits: jump every time the target changes, not only once.
  useEffect(() => {
    if (focusEntry === undefined || lastFocus.current === focusEntry) return;
    const node = boxRef.current?.querySelector<HTMLElement>(`[data-entry="${focusEntry}"]`);
    if (node === undefined || node === null) return;
    lastFocus.current = focusEntry;
    setStick(false);
    setUnseen(0);
    // Jump after layout settles, otherwise a streaming append can pull the view back.
    requestAnimationFrame(() => node.scrollIntoView({ block: "start" }));
    node.classList.add("ring-1", "ring-primary/40", "rounded-lg");
    const timer = setTimeout(() => node.classList.remove("ring-1", "ring-primary/40", "rounded-lg"), 1500);
    return () => clearTimeout(timer);
  }, [turns, focusEntry]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {unseen > 0 ? (
        <button
          onClick={() => {
            const box = boxRef.current;
            if (box !== null) box.scrollTop = box.scrollHeight;
            setStick(true);
            setUnseen(0);
          }}
          className="absolute bottom-3 left-1/2 z-10 -translate-x-1/2 rounded-full border border-primary/40 bg-background/95 px-3 py-1 text-[11px] text-primary shadow-lg backdrop-blur"
        >
          ↓ {unseen} {tr(lang, "newMessages")}
        </button>
      ) : null}
    {/* What this chat has cost so far: the ledger total, not just the loaded window. A receipt,
        not a sentence: work on the left, what it cost on the right. */}
    {usage.cost > 0 ? (
      <div className="flex shrink-0 items-baseline gap-2 border-b border-border/50 px-5 py-1 text-[10px] tabular-nums">
        <span className="text-muted-foreground/70">
          {usage.turns} {tr(lang, "turns")}
        </span>
        {totalMs > 0 ? (
          <span className="text-muted-foreground/50" title={tr(lang, "timeWindowHint")}>
            {clockOf(totalMs)}
          </span>
        ) : null}
        <span className="ml-auto flex items-baseline gap-2">
          <span className="text-muted-foreground/60">
            {usage.tokens >= 1000 ? `${(usage.tokens / 1000).toFixed(1)}k tokens` : `${usage.tokens} tokens`}
          </span>
          <span className="text-muted-foreground/25">·</span>
          <span className="text-muted-foreground" title={tr(lang, "lifetime")}>
            ${usage.cost.toFixed(usage.cost < 1 ? 3 : 2)}
          </span>
          <span className="text-muted-foreground/25">·</span>
          <span className="text-muted-foreground/50" title={tr(lang, "avgPerTurn")}>
            {tr(lang, "avgPerTurn")} ${(usage.cost / Math.max(1, usage.turns)).toFixed(3)}
          </span>
        </span>
      </div>
    ) : null}
    <div
      ref={boxRef}
      onScroll={(event) => {
        const box = event.currentTarget;
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
        setStick(atBottom);
        if (atBottom) setUnseen(0);
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
    >
      <div className="flex flex-col gap-2">
        {turns.map((turn, index) => (
          <div key={turn.id} className="flex flex-col gap-1.5" data-entry={turn.anchor.id}>
            {turn.user !== undefined ? (
              <UserBubble
                entry={turn.user}
                onRetry={() => void submit(textOf(partsOf(turn.user!.model)), "followUp")}
              />
            ) : null}
            {turn.reports.map((entry) => (
              <FeatureReport key={entry.id} entry={entry} />
            ))}
            <StepRail
              steps={turn.steps}
              stats={turn.stats}
              live={running && index === turns.length - 1}
            />
            {turn.finals.map((entry) => (
              <div key={entry.id} data-entry={entry.id}>
                <AnswerBubble
                  entry={entry}
                  retryText={turn.user === undefined ? undefined : textOf(partsOf(turn.user.model))}
                />
              </div>
            ))}
            {turn.notes.map((entry) => (
              <NoteLine key={entry.id} entry={entry} />
            ))}
            <TurnDivider stats={turn.stats} live={running && index === turns.length - 1} />
          </div>
        ))}
        <LiveBlock start={liveTurn?.stats.start} />
      </div>
    </div>
    </div>
  );
}
