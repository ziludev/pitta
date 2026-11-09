import { useState } from "react";
import { motion } from "motion/react";
import { Brain, Check, ChevronRight, Clock, FileDiff, Layers, Wrench } from "lucide-react";
import { cn } from "cn";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ToolOutput } from "@/components/ToolOutput";
import { DiffView, diffStats } from "@/lib/diff";
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
      for (const part of content as Part[]) {
        parts.push({ ...part, role: message["role"], toolName: message["toolName"] });
      }
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

/** What one internal entry did, in a few words. */
function stepLabel(entry: Entry): { icon: "brain" | "tool"; text: string } {
  const parts = partsOf(entry.model);
  const thinking = thinkingOf(parts);
  const calls = parts.filter((part) => part["type"] === "toolCall");
  const name = String(parts[0]?.["toolName"] ?? calls[0]?.["name"] ?? "tool");
  if (thinking.length > 0 && calls.length === 0) {
    return { icon: "brain", text: `${(thinking.length / 1000).toFixed(1)}k ${tr("zh", "chars")}` };
  }
  if (calls.length > 0) return { icon: "tool", text: calls.map((call) => String(call["name"] ?? "")).join(", ") };
  return { icon: "tool", text: name };
}

function StepRow({ entry, defaultOpen }: { entry: Entry; defaultOpen: boolean }) {
  const { lang } = useStore();
  const [open, setOpen] = useState(defaultOpen);
  const parts = partsOf(entry.model);
  const thinking = thinkingOf(parts);
  const text = textOf(parts);
  const label = stepLabel(entry);
  const stats = diffStats(text);

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-[11px] text-muted-foreground hover:bg-accent/10 hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        {label.icon === "brain" ? <Brain className="size-3 shrink-0" /> : <Wrench className="size-3 shrink-0" />}
        <span className="truncate">
          {label.icon === "brain" ? `${tr(lang, "thinking")} · ` : ""}
          {label.text}
        </span>
        {stats !== undefined ? (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
            +{stats.added} −{stats.removed}
          </span>
        ) : null}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="ml-4 border-l border-border py-1 pl-2">
          {thinking.length > 0 ? (
            <pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {thinking}
            </pre>
          ) : null}
          {stats !== undefined ? <DiffView text={text} open={false} /> : null}
          {thinking.length === 0 && stats === undefined ? <ToolOutput text={text} /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

type Turn = { id: number; internals: Entry[] };

/** The "think rail": every thinking/tool step of one turn, collapsed to a summary. */
export function StepRail({ turn }: { turn: Turn }) {
  const { lang } = useStore();
  const [open, setOpen] = useState(false);
  if (turn.internals.length === 0) return null;

  const thinkingCount = turn.internals.filter((entry) => thinkingOf(partsOf(entry.model)).length > 0).length;
  const toolNames = new Set<string>();
  for (const entry of turn.internals) {
    for (const part of partsOf(entry.model)) {
      if (part["type"] === "toolCall") toolNames.add(String(part["name"] ?? ""));
    }
  }
  const summary = [
    thinkingCount > 0 ? `${tr(lang, "thinking")} ×${thinkingCount}` : "",
    toolNames.size > 0 ? [...toolNames].join(", ") : "",
  ]
    .filter((piece) => piece.length > 0)
    .join(" · ");

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="max-w-[92%]">
      <CollapsibleTrigger className="group flex w-full items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-[11px] text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <Layers className="size-3 shrink-0" />
        <span className="truncate">
          {turn.internals.length} {tr(lang, "steps")}
          {summary.length > 0 ? ` · ${summary}` : ""}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="ml-2 flex flex-col gap-0.5 border-l border-border pl-2"
        >
          {turn.internals.map((entry) => (
            <StepRow key={entry.id} entry={entry} defaultOpen={false} />
          ))}
        </motion.div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export type TurnStats = { tools: number; files: number; added: number; removed: number; ms?: number };

/** The batch divider: what a finished turn amounted to. */
export function TurnDivider({ stats }: { stats: TurnStats }) {
  const { lang } = useStore();
  const pieces = [
    stats.tools > 0 ? { icon: Wrench, text: `${stats.tools} ${tr(lang, "toolCalls")}` } : undefined,
    stats.files > 0
      ? { icon: FileDiff, text: `${stats.files} ${tr(lang, "filesChanged")} · +${stats.added} −${stats.removed}` }
      : undefined,
    stats.ms !== undefined && stats.ms > 1000 ? { icon: Clock, text: formatMs(stats.ms) } : undefined,
  ].filter((piece) => piece !== undefined);

  if (pieces.length === 0) return null;
  return (
    <div className="flex items-center gap-3 py-1 text-[10px] text-muted-foreground">
      <span className="h-px flex-1 bg-border" />
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

function formatMs(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export { cn, Check };
