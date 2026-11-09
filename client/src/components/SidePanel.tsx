import { useState } from "react";
import { MessageSquarePlus, Send, Trash2 } from "lucide-react";
import { AnimateService, motion } from "motion/react";
import { Brain, GitCompareArrows, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fileStatusLabel, tr } from "@/i18n";
import { CommitDialog } from "@/components/CommitDialog";
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
  if (!changes.repo || changes.files.length === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground">{tr(lang, "noChanges")}</div>;
  }

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
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3 pb-2">
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
  const { lang, memory } = useStore();
  const groups: Array<[string, typeof memory.global]> = [
    [tr(lang, "globals"), memory.global],
    [tr(lang, "work"), memory.work],
    [tr(lang, "chat"), memory.chat],
  ];
  const total = memory.global.length + memory.work.length + memory.chat.length;
  if (total === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground">{tr(lang, "noMemory")}</div>;
  }
  return (
    <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
      <div className="flex flex-col gap-3">
        {groups.map(([title, notes]) =>
          notes.length === 0 ? null : (
            <div key={title} className="flex flex-col gap-1">
              <div className="text-[10px] tracking-wider text-muted-foreground uppercase">
                {title} · {notes.length}
              </div>
              {notes.slice(-8).map((note, index) => (
                <div key={index} className="rounded-md bg-muted/40 px-2 py-1.5 text-[11px] leading-relaxed">
                  {note.text.slice(0, 220)}
                </div>
              ))}
            </div>
          ),
        )}
      </div>
    </ScrollArea>
  );
}

export function SidePanel() {
  const { lang, tab, setTab, memory } = useStore();
  const [value, setValue] = useState(tab);
  const memoryCount = memory.global.length + memory.work.length + memory.chat.length;

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <Tabs
        value={value}
        onValueChange={(next) => {
          setValue(next as "changes" | "memory");
          setTab(next as "changes" | "memory");
        }}
        className="min-h-0 flex-1 gap-0"
      >
        <TabsList variant="line" className="w-full justify-start border-b border-border px-2">
          <TabsTrigger value="changes" className="gap-1.5 text-[11px]">
            <GitCompareArrows className="size-3" />
            {tr(lang, "changes")}
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
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.12 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <TabsContent value="changes" className="min-h-0 flex-1">
              <Changes />
            </TabsContent>
            <TabsContent value="memory" className="min-h-0 flex-1">
              <Memory />
            </TabsContent>
          </motion.div>
        </AnimateService>
      </Tabs>
    </div>
  );
}
