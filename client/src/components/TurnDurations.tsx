import { useMemo } from "react";
import { Timer } from "lucide-react";
import { clockOf, groupTurns } from "@/lib/turns";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * How long each turn took, oldest on the left. Cost has a calendar; time did not, and
 * "is this getting slower" is the question the numbers should answer without scrolling
 * through dividers looking for the slow one.
 */
export function TurnDurations() {
  const { lang, entries, approvalWaits } = useStore();
  const turns = useMemo(() => groupTurns(entries, approvalWaits), [entries, approvalWaits]);
  const spans = turns.filter((turn) => (turn.stats.ms ?? 0) > 0);
  if (spans.length === 0) return null;

  const shown = spans.slice(-30);
  const longest = Math.max(...shown.map((turn) => turn.stats.ms ?? 0));
  const total = shown.reduce((sum, turn) => sum + (turn.stats.ms ?? 0), 0);
  const slowest = shown.reduce((worst, turn) => ((turn.stats.ms ?? 0) > (worst.stats.ms ?? 0) ? turn : worst));

  return (
    <div className="border-b border-border/60 px-3 py-2">
      <div className="mb-1.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
        <Timer className="size-3" />
        <span>{tr(lang, "turnDurations")}</span>
        <span className="text-muted-foreground/40">·</span>
        <span className="tabular-nums">
          {tr(lang, "totalTime")} {clockOf(total)}
        </span>
        <span className="text-muted-foreground/40">·</span>
        <span className="tabular-nums">
          {tr(lang, "slowest")} {clockOf(slowest.stats.ms ?? 0)}
        </span>
      </div>
      <div className="flex h-14 items-end gap-[3px]">
        {shown.map((turn) => {
          const ms = turn.stats.ms ?? 0;
          const height = Math.max(3, Math.round((ms / longest) * 100));
          const waiting = turn.stats.phases.wait;
          // A bar that was mostly waiting on a human is amber: the time was not the agent's.
          const waitingShare = ms === 0 ? 0 : waiting / ms;
          return (
            <div
              key={turn.id}
              title={`${clockOf(ms)} · $${(turn.stats.cost ?? 0).toFixed(4)}${
                waiting > 0 ? ` · ${tr(lang, "waited")} ${clockOf(waiting)}` : ""
              }`}
              className="min-w-[4px] flex-1 rounded-sm bg-muted-foreground/30 transition-colors hover:bg-primary/60"
              style={{
                height: `${height}%`,
                background:
                  waitingShare > 0.5
                    ? "color-mix(in oklab, var(--color-amber-500) 70%, transparent)"
                    : undefined,
              }}
            />
          );
        })}
      </div>
      <div className="mt-1 flex justify-between text-[9px] text-muted-foreground/60">
        <span>{shown.length === spans.length ? `1–${spans.length}` : `${spans.length - shown.length + 1}–${spans.length}`}</span>
        <span>{tr(lang, "turns")}</span>
      </div>
    </div>
  );
}
