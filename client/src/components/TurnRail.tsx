import { useState } from "react";
import { motion } from "motion/react";
import { Brain, ChevronRight, Clock, Coins, FileDiff, Hash, Layers, Wrench } from "lucide-react";
import { cn } from "cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolOutput } from "@/components/ToolOutput";
import { DiffView, diffStats } from "@/lib/diff";
import { accordion, easeInOutCubic } from "@/lib/motion";
import { tr } from "@/i18n";
import type { Entry } from "@/lib/api";
import { useStore } from "@/store";

type Part = Record<string, unknown>;

export function partsOf(model: unknown): Part[] {
  const list = Array.isArray(model) ? model : [];
  const parts: Part[] = [];
  for (const message of list as Part[]) {
    const content = message["content"];
    if (typeof content === "string") parts.push({ type: "text", text: content, role: message["role"] });
    else if (Array.isArray(content)) {
      for (const part of content as Part[]) parts.push({ ...part, role: message["role"], toolName: message["toolName"] });
    }
  }
  return parts;
}

export const textOf = (parts: Part[]): string =>
  parts
    .filter((part) => part["type"] === "text")
    .map((part) => String(part["text"] ?? ""))
    .join("");

const thinkingOf = (parts: Part[]): string =>
  parts
    .filter((part) => part["type"] === "thinking")
    .map((part) => String(part["thinking"] ?? ""))
    .join("\n");

/** One step of a run: a tool call with its result, or a thinking-only response. */
export type Step = {
  id: number;
  kind: "think" | "tool" | "error";
  /** "bash · pnpm test", "read · src/main.ts", "思考" */
  label: string;
  start: number;
  end: number;
  entry: Entry;
  /** The tool result entry, when there is one. */
  result?: Entry;
};

export type TurnStats = {
  tools: number;
  files: number;
  added: number;
  removed: number;
  ms?: number;
  cost?: number;
  tokens?: number;
  /** Time split for the phase bar. */
  phases: { think: number; tool: number; error: number };
  start?: number;
  end?: number;
};

function argOf(part: Part): string {
  const args = part["arguments"] as Record<string, unknown> | undefined;
  if (args === undefined) return "";
  for (const key of ["command", "path", "query", "url", "text", "pattern"]) {
    const value = args[key];
    if (typeof value === "string" && value.length > 0) return value.replace(/\s+/g, " ").slice(0, 46);
  }
  return "";
}

function stepLabel(entry: Entry): string {
  const parts = partsOf(entry.model);
  const call = parts.find((part) => part["type"] === "toolCall");
  if (call !== undefined) {
    const name = String(call["name"] ?? "tool");
    const arg = argOf(call);
    return arg.length > 0 ? `${name} · ${arg}` : name;
  }
  const thinking = thinkingOf(parts);
  const chars = thinking.length;
  return chars > 0 ? `${tr("zh", "thinking")} · ${(chars / 1000).toFixed(1)}k` : tr("zh", "thinking");
}

function duration(ms: number): string {
  // Sub-50ms is the commit gap between two entries, not a duration worth showing.
  if (ms < 50) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

/** A tiny gantt bar: where this step sat on the turn's timeline, and how long it took. */
function StepBar({ step, turn }: { step: Step; turn: TurnStats }) {
  const start = turn.start ?? step.start;
  const end = turn.end ?? step.end;
  const span = Math.max(1, end - start);
  const left = ((step.start - start) / span) * 100;
  const width = Math.max(2, ((step.end - step.start) / span) * 100);
  const color = step.kind === "error" ? "bg-rose-500/80" : step.kind === "tool" ? "bg-muted-foreground/60" : "bg-sky-500/80";
  return (
    <span className="relative hidden h-1.5 w-16 shrink-0 rounded-full bg-muted/50 sm:block">
      <span
        className={`absolute top-0 h-1.5 rounded-full ${color}`}
        style={{ left: `${Math.min(98, left)}%`, width: `${Math.min(100 - left, width)}%` }}
      />
    </span>
  );
}

function StepRow({ step, turn }: { step: Step; turn: TurnStats }) {
  const { lang } = useStore();
  const [open, setOpen] = useState(false);
  const parts = partsOf(step.entry.model);
  const thinking = thinkingOf(parts);
  const resultText = step.result === undefined ? "" : textOf(partsOf(step.result.model));
  const stats = diffStats(resultText);
  const dot = step.kind === "error" ? "bg-rose-500" : step.kind === "tool" ? "bg-muted-foreground/70" : "bg-sky-500";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent/10 hover:text-foreground">
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          style={{ transitionDuration: `${accordion.duration}s`, transitionTimingFunction: easeInOutCubic.toString() }}
        />
        <span className={`size-1.5 shrink-0 rounded-full ${dot}`} />
        <span className="min-w-0 flex-1 truncate">{step.label}</span>
        <StepBar step={step} turn={turn} />
        <span className="w-12 shrink-0 text-right text-[10px] text-muted-foreground/70 tabular-nums">
          {duration(step.end - step.start)}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 flex flex-col gap-1 border-l border-border py-1 pl-2">
          {thinking.length > 0 ? (
            <pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {thinking}
            </pre>
          ) : null}
          {stats !== undefined ? <DiffView text={resultText} open={false} /> : null}
          {thinking.length === 0 && stats === undefined && resultText.length > 0 ? (
            <ToolOutput text={resultText} />
          ) : null}
          {thinking.length === 0 && resultText.length === 0 ? (
            <div className="text-[10.5px] text-muted-foreground">{tr(lang, "noOutput")}</div>
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** The run's machinery, collapsed to a summary; each step carries its own timing. */
export function StepRail({ steps, stats }: { steps: Step[]; stats: TurnStats }) {
  const { lang } = useStore();
  // ?steps=1 opens every rail (demos and screenshots).
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("steps") === "1");
  if (steps.length === 0) return null;

  const tools = steps.filter((step) => step.kind !== "think").length;
  const summary = [
    steps.filter((step) => step.kind === "think").length > 0
      ? `${tr(lang, "thinking")} ×${steps.filter((step) => step.kind === "think").length}`
      : "",
    tools > 0 ? `${tools} ${tr(lang, "toolCalls")}` : "",
  ]
    .filter((piece) => piece.length > 0)
    .join(" · ");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[92%]">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight
          className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-180"
          style={{ transitionDuration: `${accordion.duration}s` }}
        />
        <Layers className="size-3 shrink-0" />
        <span className="truncate">
          {steps.length} {tr(lang, "steps")}
          {summary.length > 0 ? ` · ${summary}` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: accordion.duration, ease: easeInOutCubic }}
          className="ml-2 flex flex-col gap-0.5 overflow-hidden border-l border-border pl-2"
        >
          {steps.map((step) => (
            <StepRow key={step.id} step={step} turn={stats} />
          ))}
        </motion.div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Proportion of the turn spent thinking / running tools / failing. */
function PhaseBar({ phases }: { phases: TurnStats["phases"] }) {
  const total = Math.max(1, phases.think + phases.tool + phases.error);
  const segments = [
    { key: "think", value: phases.think, className: "bg-sky-500/70", label: "思考" },
    { key: "tool", value: phases.tool, className: "bg-muted-foreground/50", label: "工具" },
    { key: "error", value: phases.error, className: "bg-rose-500/70", label: "失败" },
  ].filter((segment) => segment.value > 0);
  if (segments.length === 0) return null;

  return (
    <span className="flex h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-muted/30">
      {segments.map((segment) => (
        <span
          key={segment.key}
          className={segment.className}
          style={{ width: `${(segment.value / total) * 100}%` }}
          title={`${segment.label} ${duration(segment.value)}`}
        />
      ))}
    </span>
  );
}

/** The batch divider: what a finished turn amounted to. */
export function TurnDivider({ stats }: { stats: TurnStats }) {
  const { lang } = useStore();
  const pieces = [
    stats.tools > 0 ? { icon: Wrench, text: `${stats.tools} ${tr(lang, "toolCalls")}` } : undefined,
    stats.files > 0
      ? { icon: FileDiff, text: `${stats.files} ${tr(lang, "filesChanged")} · +${stats.added} −${stats.removed}` }
      : undefined,
    stats.tokens !== undefined && stats.tokens > 0
      ? { icon: Hash, text: stats.tokens >= 1000 ? `${(stats.tokens / 1000).toFixed(1)}k` : String(stats.tokens) }
      : undefined,
    stats.cost !== undefined && stats.cost > 0.00005 ? { icon: Coins, text: `$${stats.cost.toFixed(4)}` } : undefined,
    stats.ms !== undefined && stats.ms > 1000 ? { icon: Clock, text: duration(stats.ms) } : undefined,
  ].filter((piece) => piece !== undefined);

  if (pieces.length === 0) return null;
  return (
    <div className="flex items-center gap-2.5 py-1 text-[10px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
      <PhaseBar phases={stats.phases} />
      {pieces.map((piece, index) => (
        <span key={index} className="flex shrink-0 items-center gap-1">
          <piece.icon className="size-3" />
          {piece.text}
        </span>
      ))}
      <span className="h-px flex-1 bg-border" />
    </div>
  );
}
