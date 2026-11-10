import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { Copy, Pencil, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { tr } from "@/i18n";
import type { Entry } from "@/lib/api";
import { diffStats } from "@/lib/diff";
import { Markdown } from "@/lib/markdown";
import { StepRail, TurnDivider, partsOf, textOf, type TurnStats } from "@/components/TurnRail";
import { Spinner } from "@/components/ui/spinner";
import { useStore } from "@/store";

type Turn = {
  id: number;
  anchor: Entry;
  user?: Entry;
  finals: Entry[];
  reports: Entry[];
  internals: Entry[];
  stats: TurnStats;
};

const isThinkingOrTool = (entry: Entry): boolean => {
  const parts = partsOf(entry.model);
  const hasCall = parts.some((part) => part["type"] === "toolCall");
  const hasText = textOf(parts).trim().length > 0;
  if (entry.kind === "pi.tool-result") return true;
  if (entry.kind !== "pi.assistant") return false;
  // A tool-calling answer is machinery; a text answer is the answer.
  return hasCall || !hasText;
};

/** Plain text of an entry, for in-conversation search. */
function entryText(entry: Entry): string {
  const parts = partsOf(entry.model);
  const payload = (entry.data ?? {}) as { text?: string };
  return `${textOf(parts)} ${payload.text ?? ""}`.trim();
}

function timestampOf(entry: Entry): number | undefined {
  const messages = Array.isArray(entry.model) ? (entry.model as Array<Record<string, unknown>>) : [];
  const stamped = messages.find((message) => typeof message["timestamp"] === "number");
  return stamped === undefined ? undefined : (stamped["timestamp"] as number);
}

/** Groups the transcript into turns: user message → machinery → answer. */
function groupTurns(entries: Entry[]): Turn[] {
  const turns: Turn[] = [];
  let current: Turn | undefined;

  for (const entry of entries) {
    if (entry.kind === "pi.system") continue;

    if (entry.kind === "pi.user" || entry.kind === "app.feature-report" || current === undefined) {
      current = {
        id: entry.id,
        anchor: entry,
        user: entry.kind === "pi.user" ? entry : undefined,
        finals: [],
        reports: entry.kind === "app.feature-report" ? [entry] : [],
        internals: [],
        stats: { tools: 0, files: 0, added: 0, removed: 0 },
      };
      turns.push(current);
      continue;
    }

    if (isThinkingOrTool(entry)) current.internals.push(entry);
    else current.finals.push(entry);
  }

  for (const turn of turns) {
    const timestamps = [turn.anchor, ...turn.internals, ...turn.finals]
      .map(timestampOf)
      .filter((value): value is number => value !== undefined);
    const paths = new Set<string>();
    let added = 0;
    let removed = 0;
    let tools = 0;
    let cost = 0;

    // pi records usage on every assistant message; the turn's spend is their sum.
    for (const entry of [...turn.internals, ...turn.finals]) {
      const messages = Array.isArray(entry.model) ? (entry.model as unknown as Array<Record<string, unknown>>) : [];
      for (const message of messages) {
        const usage = message["usage"] as { cost?: { total?: number } } | undefined;
        cost += usage?.cost?.total ?? 0;
      }
    }

    for (const entry of turn.internals) {
      for (const part of partsOf(entry.model)) {
        if (part["type"] === "toolCall") {
          tools += 1;
          const args = part["arguments"] as Record<string, unknown> | undefined;
          const path = typeof args?.["path"] === "string" ? (args["path"] as string) : undefined;
          if (path !== undefined) paths.add(path);
        }
        if (part["type"] === "text") {
          const stats = diffStats(String(part["text"] ?? ""));
          if (stats !== undefined) {
            added += stats.added;
            removed += stats.removed;
          }
        }
      }
    }

    turn.stats = {
      tools,
      files: paths.size,
      added,
      removed,
      cost,
      ms: timestamps.length >= 2 ? timestamps[timestamps.length - 1]! - timestamps[0]! : undefined,
    };
  }
  return turns;
}

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
  const images = parts.filter((part) => part["type"] === "image").length;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="group flex items-start justify-end gap-1">
      <div className="mt-1 shrink-0">
        <MessageActions text={textOf(parts)} onRetry={onRetry} />
      </div>
      <div className="max-w-[86%] rounded-xl rounded-br-sm border border-primary/25 bg-primary/12 px-3 py-2 text-[13px] leading-relaxed">
        <Markdown text={textOf(parts)} highlight={convQuery} />
        {images > 0 ? (
          <div className="mt-1 text-[10px] text-muted-foreground">
            [{images} {tr(lang, "images")}]
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

function LiveBlock() {
  const { live } = useStore();
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
  if (running === undefined && partial.length === 0) return null;
  return (
    <motion.div initial={{ opacity: 0.7 }} animate={{ opacity: 1 }} className="flex max-w-[92%] flex-col gap-1.5">
      {running !== undefined ? (
        <span className="flex w-fit items-center gap-1.5 rounded-full border border-primary/40 px-2 py-0.5 font-mono text-[10px] text-primary">
          <Spinner size={10} />
          {String(running["name"] ?? "")}
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
  const { entries, focusEntry, lang, convQuery, setConvMatches, submit } = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const lastFocus = useRef<number | undefined>(undefined);
  const seenCount = useRef(0);
  const turns = useMemo(() => groupTurns(entries), [entries]);

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
        {turns.map((turn) => (
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
            <StepRail turn={turn} />
            {turn.finals.map((entry) => (
              <div key={entry.id} data-entry={entry.id}>
                <AnswerBubble
                  entry={entry}
                  retryText={turn.user === undefined ? undefined : textOf(partsOf(turn.user.model))}
                />
              </div>
            ))}
            <TurnDivider stats={turn.stats} />
          </div>
        ))}
        <LiveBlock />
      </div>
    </div>
    </div>
  );
}
