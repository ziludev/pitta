import { useEffect, useRef, useState } from "react";
import { MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { AnimateService, motion } from "motion/react";
import { Brain, Check, GitCommitHorizontal, GitCompareArrows, RefreshCw, Signal, Wand2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fileStatusLabel, tr } from "@/i18n";
import { cssEase, easeInOutCubic, easeOutCubic, hoverLift, tabs } from "@/lib/motion";
import { EmptyState } from "@/components/ui/empty-state";
import { Spinner } from "@/components/ui/spinner";
import { CommitDialog } from "@/components/CommitDialog";
import { Commits } from "@/components/Commits";
import { TurnDurations } from "@/components/TurnDurations";
import { UsageCalendar } from "@/components/UsageCalendar";
import { MergeButton } from "@/components/MergeButton";
import { DiffView } from "@/lib/diff";
import { useStore } from "@/store";

function Changes() {
  const {
    lang,
    changes,
    changesLoading,
    loadChanges,
    openFile,
    review,
    addReviewComment,
    removeReviewComment,
    clearReview,
    sendReview,
  } = useStore();
  const [picked, setPicked] = useState<{ path: string; line: string } | undefined>();
  const [note, setNote] = useState("");

  if (changes === undefined) {
    return <div className="p-3 text-[11px] text-muted-foreground">{changesLoading ? "…" : ""}</div>;
  }
  if (!changes.repo) {
    return <div className="p-3 text-[11px] text-muted-foreground">{tr(lang, "noChanges")}</div>;
  }
  // A clean tree is exactly when merging makes sense, so the header stays.
  const empty = changes.files.length === 0;

  function takeComment() {
    if (picked === undefined || note.trim().length === 0) return;
    addReviewComment({ ...picked, note: note.trim() });
    setPicked(undefined);
    setNote("");
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="truncate text-[11px] text-muted-foreground">
          {changes.files.length} {tr(lang, "diffSummary")}
          {changes.truncated ? ` · ${tr(lang, "truncated")}` : ""}
          {changes.branch !== undefined && changes.branch.length > 0 ? ` · ${changes.branch}` : ""}
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-xs" onClick={() => void loadChanges()} title={tr(lang, "refresh")}>
            <RefreshCw className="size-3" />
          </Button>
          <CommitDialog files={changes.files.length} />
          {changes.branch?.startsWith("agent/") ? <MergeButton /> : null}
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3 pb-2 w-full [&_[data-radix-scroll-area-viewport]>div]:!block">
        {empty ? (
          <EmptyState title={tr(lang, "noChanges")} hint={tr(lang, "noChangesHint")} />
        ) : (
        <div className="flex flex-col gap-1.5">
          {changes.files.map((file) => (
            <button
              key={file.path}
              onClick={() => openFile(file.path)}
              className="flex items-baseline gap-2 rounded px-1 text-left text-[11px] hover:bg-accent/10"
            >
              <Badge variant="outline" className="shrink-0 text-[9px]">
                {fileStatusLabel(lang, file.status)}
              </Badge>
              <span className="truncate font-mono text-[11px]">{file.path}</span>
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                {file.added > 0 ? `+${file.added}` : ""}
                {file.removed > 0 ? ` −${file.removed}` : ""}
              </span>
            </button>
          ))}
          <div className="mt-1">
            <DiffView
              text={changes.diff}
              open={changes.files.length <= 3}
              onPickLine={(path, line) => {
                setPicked({ path, line });
                setNote("");
              }}
            />
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">{tr(lang, "reviewHint")}</div>
        </div>
        )}
      </ScrollArea>

      <div className="border-t border-border p-2">
        {picked !== undefined ? (
          <div className="mb-2 flex flex-col gap-1">
            <div className="truncate font-mono text-[10px] text-muted-foreground">
              {picked.path} · {picked.line.trim().slice(0, 60)}
            </div>
            <div className="flex gap-1">
              <Input
                autoFocus
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder={tr(lang, "review")}
                className="h-7 text-[11px]"
                onKeyDown={(event) => {
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  takeComment();
                }}
              />
              <Button size="icon-xs" variant="secondary" onClick={takeComment}>
                <MessageSquarePlus className="size-3" />
              </Button>
            </div>
          </div>
        ) : null}

        {review.length > 0 ? (
          <div className="flex flex-col gap-1">
            <div className="flex items-center justify-between text-[10px] text-muted-foreground">
              <span>
                {tr(lang, "review")} · {review.length}
              </span>
              <button onClick={clearReview} className="hover:text-foreground" title={tr(lang, "clearReview")}>
                <Trash2 className="size-3" />
              </button>
            </div>
            <div className="max-h-24 overflow-y-auto">
              {review.map((item, index) => (
                <button
                  key={index}
                  onClick={() => removeReviewComment(index)}
                  className="block w-full truncate text-left text-[10px] text-muted-foreground hover:text-foreground"
                >
                  {item.path} → {item.note}
                </button>
              ))}
            </div>
            <Button size="xs" onClick={() => void sendReview()}>
              <Send className="size-3" />
              {tr(lang, "sendReview")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Memory() {
  const {
    lang,
    memory,
    memoryQuery,
    setMemoryQuery,
    memorySuggestions,
    curating,
    curateMemory,
    applySuggestions,
    clearSuggestions,
  } = useStore();
  const [selected, setSelected] = useState<Record<number, boolean>>({});
  useEffect(() => {
    if (new URLSearchParams(location.search).get("curate") === "1") void curateMemory(24);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [busy, setBusy] = useState(false);

  const needle = memoryQuery.trim().toLowerCase();
  const filter = (notes: typeof memory.global) =>
    needle.length === 0 ? notes : notes.filter((note) => note.text.toLowerCase().includes(needle));

  const groups: Array<[string, typeof memory.global]> = [
    [tr(lang, "globals"), filter(memory.global)],
    [tr(lang, "work"), filter(memory.work)],
    [tr(lang, "chat"), filter(memory.chat)],
  ];
  const total = memory.global.length + memory.work.length + memory.chat.length;
  const picked = memorySuggestions.filter((_, index) => selected[index] !== false);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2">
        <Input
          value={memoryQuery}
          onChange={(event) => setMemoryQuery(event.target.value)}
          placeholder={tr(lang, "searchMemory")}
          className="h-7 text-[11px]"
        />
        <Button
          variant="outline"
          size="xs"
          className="shrink-0"
          disabled={curating}
          title={tr(lang, "curateHint")}
          onClick={async () => {
            const result = await curateMemory(24);
            toast(`${tr(lang, "curated")} · ${result.suggested}/${result.scanned}`);
          }}
        >
          {curating ? <Spinner size={12} /> : <Wand2 className="size-3" />}
          {curating ? tr(lang, "curating") : tr(lang, "curate")}
        </Button>
      </div>

      {memorySuggestions.length > 0 ? (
        <div
          className="mx-3 mb-2 shrink-0 rounded-lg border border-primary/30 bg-primary/5 p-2 transition-[transform,box-shadow] hover:-translate-y-1 hover:shadow-[0_12px_22px_-8px_rgba(0,0,0,0.5)]"
          style={{ transitionDuration: `${hoverLift.duration}s`, transitionTimingFunction: cssEase(easeOutCubic) }}
        >
          <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
            <span>
              {tr(lang, "suggestions")} · {memorySuggestions.length}
            </span>
            <button onClick={clearSuggestions} className="hover:text-foreground">
              {tr(lang, "clear")}
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto">
            {memorySuggestions.map((suggestion, index) => (
              <label
                key={index}
                className="flex cursor-pointer items-start gap-1.5 rounded px-1 py-1 hover:bg-accent/10"
              >
                <input
                  type="checkbox"
                  checked={selected[index] !== false}
                  onChange={(event) => setSelected((state) => ({ ...state, [index]: event.target.checked }))}
                  className="mt-0.5 size-3 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11.5px] leading-snug">{suggestion.text}</span>
                  <span className="block text-[10px] text-muted-foreground">
                    <Badge variant="outline" className="mr-1 text-[9px]">
                      {suggestion.scope}
                    </Badge>
                    {suggestion.reason ?? ""}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <Button
            size="xs"
            className="mt-1.5 w-full"
            disabled={busy || picked.length === 0}
            onClick={async () => {
              setBusy(true);
              try {
                const result = await applySuggestions(picked);
                toast(`${tr(lang, "applied")} +${result.added}${result.skipped > 0 ? ` · ${tr(lang, "skipped")} ${result.skipped}` : ""}`);
                setSelected({});
              } finally {
                setBusy(false);
              }
            }}
          >
            <Check className="size-3" />
            {tr(lang, "apply")} {picked.length}
          </Button>
        </div>
      ) : null}

      {total === 0 ? (
        <EmptyState title={tr(lang, "noMemory")} hint={tr(lang, "noMemoryHint")} />
      ) : (
        <ScrollArea className="h-full min-h-0 w-full [&_[data-radix-scroll-area-viewport]>div]:!block">
          <div className="flex flex-col gap-3 px-3 pb-3">
            {groups.map(([title, notes]) =>
              notes.length === 0 ? null : (
                <div key={title} className="flex flex-col gap-1">
                  <div className="text-[10px] tracking-wider text-muted-foreground uppercase">
                    {title} · {notes.length}
                  </div>
                  {notes.slice(-40).map((note, index) => (
                    <div key={index} className="rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed break-words">
                      {note.text.slice(0, 220)}
                    </div>
                  ))}
                </div>
              ),
            )}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

export function SidePanel() {
  const { lang, tab, setTab, memory } = useStore();
  const [value, setValue] = useState<"changes" | "usage" | "memory">(
    tab === "memory" ? "memory" : (new URLSearchParams(location.search).get("tab") as "changes" | "usage" | null) ?? "changes",
  );
  const listRef = useRef<HTMLDivElement>(null);
  const [underline, setUnderline] = useState({ left: 0, width: 0 });

  // #057: the underline travels 250ms easeInOutCubic to the newly selected tab.
  useEffect(() => {
    const list = listRef.current;
    if (list === null) return;
    const measure = (): void => {
      const active = list.querySelector<HTMLElement>('[data-state="active"]');
      if (active === null) return;
      const box = active.getBoundingClientRect();
      const frame = list.getBoundingClientRect();
      setUnderline({ left: box.left - frame.left, width: box.width });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(list);
    return () => observer.disconnect();
  }, [value, lang]);
  const memoryCount = memory.global.length + memory.work.length + memory.chat.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <Tabs
        value={value}
        onValueChange={(next) => {
          setValue(next as "changes" | "usage" | "memory");
          setTab(next as "changes" | "memory");
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList
          ref={listRef}
          variant="line"
          className="relative w-full justify-start overflow-hidden border-b border-border px-2 [&_[data-state=active]]:border-b-0"
        >
          <span
            aria-hidden
            className="pointer-events-none absolute bottom-0 h-[2px] rounded-full bg-primary"
            style={{
              width: underline.width,
              transform: `translateX(${underline.left}px)`,
              transition: `transform ${tabs.underline}s cubic-bezier(0.65, 0, 0.35, 1), width ${tabs.underline}s cubic-bezier(0.65, 0, 0.35, 1)`,
            }}
          />
          <TabsTrigger value="changes" className="gap-1.5 text-[11px]">
            <GitCompareArrows className="size-3" />
            {tr(lang, "changes")}
          </TabsTrigger>
          <TabsTrigger value="commits" className="gap-1.5 text-[11px]">
            <GitCommitHorizontal className="size-3" />
            {tr(lang, "commits")}
          </TabsTrigger>
          <TabsTrigger value="usage" className="gap-1.5 text-[11px]">
            <Signal className="size-3" />
            {tr(lang, "usage")}
          </TabsTrigger>
          <TabsTrigger value="memory" className="gap-1.5 text-[11px]">
            <Brain className="size-3" />
            {tr(lang, "memory")}
            <span className="text-[10px] text-muted-foreground tabular-nums">{memoryCount}</span>
          </TabsTrigger>
        </TabsList>
        <AnimateService mode="wait" initial={false}>
          <motion.div
            key={value}
            initial={{ opacity: 0, y: tabs.rise }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: tabs.content, ease: easeOutCubic, delay: tabs.handover }}
            exit={{ opacity: 0, y: -tabs.rise, transition: { duration: tabs.content, delay: 0, ease: easeInOutCubic } }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsContent value="changes" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Changes />
            </TabsContent>
            <TabsContent value="commits" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Commits />
            </TabsContent>
            <TabsContent value="usage" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <TurnDurations />
              <UsageCalendar />
            </TabsContent>
            <TabsContent value="memory" className="flex min-h-0 flex-1 flex-col overflow-hidden">
              <Memory />
            </TabsContent>
          </motion.div>
        </AnimateService>
      </Tabs>
    </div>
  );
}
