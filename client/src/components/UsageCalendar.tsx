import { useEffect, useMemo } from "react";
import { tr } from "@/i18n";
import type { UsageDay } from "@/lib/api";
import { useStore } from "@/store";

const WEEKS = 17;
const LEVELS = [
  "bg-muted/40",
  "bg-emerald-900/70",
  "bg-emerald-700/80",
  "bg-emerald-500/85",
  "bg-emerald-400",
];

function level(tokens: number, max: number): number {
  if (tokens <= 0) return 0;
  const ratio = max <= 0 ? 1 : tokens / max;
  if (ratio < 0.25) return 1;
  if (ratio < 0.5) return 2;
  if (ratio < 0.8) return 3;
  return 4;
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(2)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
  return String(tokens);
}

/** GitHub-style contribution grid, but for tokens burned per day. */
export function UsageCalendar() {
  const { lang, usageDays, loadUsage } = useStore();

  useEffect(() => {
    void loadUsage();
  }, [loadUsage]);

  const { cells, max, total, last7, last30 } = useMemo(() => {
    const byDate = new Map(usageDays.map((day) => [day.date, day]));
    const today = new Date();
    // Grid ends today and starts on the Sunday of the first shown week.
    const start = new Date(today);
    start.setDate(start.getDate() - (WEEKS * 7 - 1));
    start.setDate(start.getDate() - start.getDay());

    const cells: Array<{ date: string; tokens: number; cost: number }> = [];
    for (let cursor = new Date(start); cursor <= today; cursor.setDate(cursor.getDate() + 1)) {
      const key = cursor.toLocaleDateString("sv-SE");
      const day = byDate.get(key);
      cells.push({ date: key, tokens: day?.tokens ?? 0, cost: day?.cost ?? 0 });
    }
    const values = cells.map((cell) => cell.tokens);
    const tail = (count: number) =>
      cells.slice(-count).reduce((sum, cell) => sum + cell.tokens, 0);
    return {
      cells,
      max: Math.max(0, ...values),
      total: cells.reduce((sum, cell) => sum + cell.tokens, 0),
      last7: tail(7),
      last30: tail(30),
    };
  }, [usageDays]);

  const columns: Array<Array<{ date: string; tokens: number; cost: number }>> = [];
  for (let index = 0; index < cells.length; index += 7) columns.push(cells.slice(index, index + 7));

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-3">
      <div className="flex items-baseline justify-between text-[11px] text-muted-foreground">
        <span>
          {tr(lang, "tokens7")} <span className="text-foreground tabular-nums">{formatTokens(last7)}</span>
        </span>
        <span>
          {tr(lang, "tokens30")} <span className="text-foreground tabular-nums">{formatTokens(last30)}</span>
        </span>
      </div>

      <div className="flex gap-[3px]">
        {columns.map((week, weekIndex) => (
          <div key={weekIndex} className="flex flex-col gap-[3px]">
            {Array.from({ length: 7 }, (_, dayIndex) => {
              const cell = week[dayIndex];
              if (cell === undefined) return <span key={dayIndex} className="size-2.5 rounded-sm" />;
              return (
                <span
                  key={cell.date}
                  title={`${cell.date} · ${cell.tokens.toLocaleString()} tokens · $${cell.cost.toFixed(4)}`}
                  className={`size-2.5 rounded-sm ${LEVELS[level(cell.tokens, max)]}`}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>
          {tr(lang, "total")} <span className="tabular-nums">{formatTokens(total)}</span> tokens
        </span>
        <span className="flex items-center gap-1">
          {tr(lang, "less")}
          {LEVELS.map((className) => (
            <span key={className} className={`size-2.5 rounded-sm ${className}`} />
          ))}
          {tr(lang, "more")}
        </span>
      </div>
    </div>
  );
}
