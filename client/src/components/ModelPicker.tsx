import { useEffect, useMemo, useState } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  KeyRound,
  RefreshCw,
  Search,
  Star,
  StarOff,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Slider } from "@/components/ui/slider";
import { tr } from "@/i18n";
import type { ModelEntry } from "@/lib/api";
import { useStore } from "@/store";

const LEVEL_LABEL: Record<"zh" | "en", Record<string, string>> = {
  zh: { off: "关", minimal: "极低", low: "低", medium: "中", high: "高", xhigh: "很高", max: "最高" },
  en: { off: "off", minimal: "min", low: "low", medium: "mid", high: "high", xhigh: "xhigh", max: "max" },
};

const levelText = (lang: "zh" | "en", level?: string): string =>
  LEVEL_LABEL[lang][level ?? "high"] ?? level ?? "";

function formatCtx(window: number): string {
  if (window >= 1_000_000) return `${(window / 1_048_576).toFixed(0)}M`;
  if (window >= 1_000) return `${Math.round(window / 1_000)}k`;
  return String(window);
}

function formatPrice(model: ModelEntry, lang: "zh" | "en"): string {
  if (model.cost.input === 0 && model.cost.output === 0) return lang === "zh" ? "免费" : "free";
  return `${lang === "zh" ? "每百万" : "per M"} $${model.cost.input} / $${model.cost.output}`;
}

/** Mini bars: how hard the model is thinking right now. */
function LevelBars({ levels, value }: { levels: string[]; value?: string }) {
  const index = Math.max(0, levels.indexOf(value ?? "high"));
  return (
    <span className="flex items-end gap-[2px]">
      {[0, 1, 2, 3].map((bar) => (
        <span
          key={bar}
          className={cn(
            "w-[2px] rounded-sm",
            bar === 0 ? "h-1" : bar === 1 ? "h-1.5" : bar === 2 ? "h-2" : "h-2.5",
            index >= bar && index > 0 ? "bg-emerald-400" : "bg-muted-foreground/40",
          )}
        />
      ))}
    </span>
  );
}

function ModelRow({
  model,
  active,
  favorite,
  onPick,
  onStar,
}: {
  model: ModelEntry;
  active: boolean;
  favorite: boolean;
  onPick: () => void;
  onStar: () => void;
}) {
  return (
    <div
      className={cn(
        "group flex cursor-pointer items-start gap-2 rounded-md px-2 py-1.5 hover:bg-accent/15",
        active && "bg-accent/20",
      )}
      onClick={onPick}
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded bg-muted text-[10px] font-medium text-muted-foreground">
        {model.name.slice(0, 1).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-[12.5px]">{model.name}</span>
          {active ? <Check className="size-3 shrink-0 text-primary" /> : null}
        </div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {model.provider} · {formatPrice(model, useStore.getState().lang)} · {formatCtx(model.contextWindow)}
        </div>
      </div>
      <button
        onClick={(event) => {
          event.stopPropagation();
          onStar();
        }}
        className="mt-0.5 shrink-0 text-muted-foreground/40 opacity-0 transition group-hover:opacity-100"
        title={tr(useStore.getState().lang, "favorite")}
      >
        {favorite ? <Star className="size-3 text-amber-400 opacity-100" /> : <StarOff className="size-3" />}
      </button>
    </div>
  );
}

/**
 * Command-palette model switcher: search, favourites, recents, provider groups and
 * a thinking-level slider at the bottom (ThinkRail's shape, our data).
 */
export function ModelPicker() {
  const {
    lang,
    model,
    thinkingLevel,
    models,
    favorites,
    recents,
    loadModels,
    setModel,
    setDefaultModel,
    toggleFavorite,
  } = useStore();
  const [open, setOpen] = useState(new URLSearchParams(location.search).get("models") === "1");
  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void loadModels();
  }, [loadModels]);

  const current = models.find((entry) => entry.provider === model?.provider && entry.id === model?.modelId);
  const levels = current?.thinkingLevels ?? ["off", "low", "medium", "high", "max"];
  const levelIndex = Math.max(0, levels.indexOf(thinkingLevel ?? "high"));

  const { recentModels, groups, filtered } = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = (entry: ModelEntry): boolean =>
      needle.length === 0 ||
      entry.name.toLowerCase().includes(needle) ||
      entry.id.toLowerCase().includes(needle) ||
      entry.provider.toLowerCase().includes(needle);

    const byKey = new Map(models.map((entry) => [`${entry.provider}/${entry.id}`, entry]));
    const recentModels = recents
      .map((key) => byKey.get(key))
      .filter((entry): entry is ModelEntry => entry !== undefined && matches(entry));

    const grouped = new Map<string, ModelEntry[]>();
    for (const entry of models.filter(matches)) {
      const list = grouped.get(entry.provider) ?? [];
      list.push(entry);
      grouped.set(entry.provider, list);
    }
    // Favourites float to the top inside their provider group.
    for (const list of grouped.values()) {
      list.sort((a, b) => {
        const fa = favorites.includes(`${a.provider}/${a.id}`) ? 0 : 1;
        const fb = favorites.includes(`${b.provider}/${b.id}`) ? 0 : 1;
        return fa - fb || a.name.localeCompare(b.name);
      });
    }
    const currentProvider = model?.provider ?? "";
    const ordered = [...grouped.entries()].sort(([a], [b]) => {
      if (a === currentProvider) return -1;
      if (b === currentProvider) return 1;
      return a.localeCompare(b);
    });
    return { recentModels, groups: ordered, filtered: models.filter(matches).length };
  }, [models, recents, favorites, query, model?.provider]);

  if (model === undefined) return null;

  async function pick(entry: ModelEntry): Promise<void> {
    await setModel({
      provider: entry.provider,
      modelId: entry.id,
      thinkingLevel: entry.thinkingLevels.includes(thinkingLevel ?? "high") ? thinkingLevel : entry.thinkingLevels.at(-1),
    });
    setOpen(false);
    setQuery("");
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="xs" className="max-w-[300px] gap-1.5 px-1 text-[11px] text-muted-foreground hover:text-foreground">
          <span className="flex size-3.5 shrink-0 items-center justify-center rounded bg-muted text-[9px] text-muted-foreground">
            M
          </span>
          <span className="truncate">{current?.name ?? model.modelId}</span>

          <LevelBars levels={levels} value={thinkingLevel} />
          <span className="shrink-0 text-muted-foreground">{levelText(lang, thinkingLevel)}</span>
          <KeyRound className="size-3 shrink-0 text-muted-foreground" />
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        </Button>
      </PopoverTrigger>

      {/* Glass: the picker floats over the transcript, which is the only way it reads as
          material rather than a flat panel. */}
      <PopoverContent align="start" className="glass w-[520px] overflow-hidden p-0">
        {/* Height lives on this inner column: the popover itself must not grow past it. */}
        <div className="flex max-h-[68vh] flex-col">
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
          <Search className="size-3.5 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={tr(lang, "searchModel")}
            className="h-6 border-none px-0 text-[12px] shadow-none focus-visible:ring-0"
          />
          <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">{filtered}</span>
        </div>

        <ScrollArea className="min-h-0 flex-1 overflow-hidden">
          <div className="p-1.5">
            {recentModels.length > 0 && query.length === 0 ? (
              <div className="mb-1">
                <div className="px-2 py-1 text-[10px] tracking-wider text-muted-foreground uppercase">
                  {tr(lang, "recent")}
                </div>
                {recentModels.map((entry) => (
                  <ModelRow
                    key={`recent-${entry.provider}/${entry.id}`}
                    model={entry}
                    active={entry.provider === model.provider && entry.id === model.modelId}
                    favorite={favorites.includes(`${entry.provider}/${entry.id}`)}
                    onPick={() => void pick(entry)}
                    onStar={() => toggleFavorite(`${entry.provider}/${entry.id}`)}
                  />
                ))}
              </div>
            ) : null}

            {groups.map(([provider, entries]) => {
              // Only the provider in use opens by default; the rest stay collapsed.
              const isCollapsed = collapsed[provider] ?? provider !== model.provider;
              return (
                <div key={provider} className="mb-0.5">
                  <button
                    onClick={() => setCollapsed((state) => ({ ...state, [provider]: !isCollapsed }))}
                    className="flex w-full items-center gap-1.5 rounded-md px-2 py-1.5 text-left hover:bg-accent/10"
                  >
                    {isCollapsed ? (
                      <ChevronRight className="size-3 text-muted-foreground" />
                    ) : (
                      <ChevronDown className="size-3 text-muted-foreground" />
                    )}
                    <KeyRound className="size-3 text-muted-foreground" />
                    <span className="text-[12px] font-medium">{provider}</span>
                    <span className="ml-auto text-[10px] text-muted-foreground tabular-nums">{entries.length}</span>
                  </button>
                  {!isCollapsed
                    ? entries.map((entry) => (
                        <ModelRow
                          key={`${entry.provider}/${entry.id}`}
                          model={entry}
                          active={entry.provider === model.provider && entry.id === model.modelId}
                          favorite={favorites.includes(`${entry.provider}/${entry.id}`)}
                          onPick={() => void pick(entry)}
                          onStar={() => toggleFavorite(`${entry.provider}/${entry.id}`)}
                        />
                      ))
                    : null}
                </div>
              );
            })}
          </div>
        </ScrollArea>

        <div className="shrink-0 border-t border-border px-3 py-2.5">
          <div className="mb-1.5 flex items-baseline justify-between text-[10px] text-muted-foreground">
            <span>
              {tr(lang, "effort")} · {current?.name ?? model.modelId} · {model.provider}
            </span>
            <span className="flex items-center gap-1 text-[11px] text-emerald-400">
              <Sparkles className="size-3" />
              {levelText(lang, levels[levelIndex])}
            </span>
          </div>
          <Slider
            value={[levelIndex]}
            min={0}
            max={Math.max(levels.length - 1, 1)}
            step={1}
            onValueChange={([index]) => {
              const level = levels[index ?? 0];
              if (level !== undefined) void setModel({ provider: model.provider, modelId: model.modelId, thinkingLevel: level });
            }}
            className="[&_[data-slot=slider-range]]:bg-gradient-to-r [&_[data-slot=slider-range]]:from-sky-400 [&_[data-slot=slider-range]]:to-emerald-400"
          />
          <div className="mt-1 flex justify-between text-[10px] text-muted-foreground">
            {levels.map((level) => (
              <span key={level}>{levelText(lang, level)}</span>
            ))}
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between border-t border-border px-2 py-1.5">
          <Button
            variant="ghost"
            size="xs"
            onClick={async () => {
              await setDefaultModel({ provider: model.provider, modelId: model.modelId, thinkingLevel });
              toast(tr(lang, "defaultSet"));
            }}
          >
            {tr(lang, "setDefault")}
          </Button>
          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              void loadModels(true);
              toast(tr(lang, "refreshed"));
            }}
          >
            <RefreshCw className="size-3" />
            {tr(lang, "refresh")}
          </Button>
        </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
