import { useState } from "react";
import { AnimateService, motion } from "motion/react";
import { Brain, GitCompareArrows, RefreshCw, Check } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { fileStatusLabel, tr } from "@/i18n";
import { DiffView } from "@/lib/diff";
import { useStore } from "@/store";

function Changes() {
  const { lang, changes, changesLoading, loadChanges, commit } = useStore();

  if (changes === undefined) {
    return <div className="p-3 text-[11px] text-muted-foreground">{changesLoading ? "…" : ""}</div>;
  }
  if (!changes.repo || changes.files.length === 0) {
    return <div className="p-3 text-[11px] text-muted-foreground">{tr(lang, "noChanges")}</div>;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-3 py-2">
        <span className="text-[11px] text-muted-foreground">
          {changes.files.length} {tr(lang, "diffSummary")}
          {changes.truncated ? ` · ${tr(lang, "truncated")}` : ""}
        </span>
        <div className="flex gap-1">
          <Button variant="ghost" size="icon-xs" onClick={() => void loadChanges()} title={tr(lang, "refresh")}>
            <RefreshCw className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="xs"
            title={tr(lang, "commit")}
            onClick={() => {
              const message = window.prompt(tr(lang, "commitMessage"), "");
              if (message === null) return;
              commit(message)
                .then((head) => toast(`${tr(lang, "committed")} ${head}`))
                .catch(() => toast.error(tr(lang, "nothingToCommit")));
            }}
          >
            <Check className="size-3" />
            {tr(lang, "commit")}
          </Button>
        </div>
      </div>

      <ScrollArea className="min-h-0 flex-1 px-3 pb-3">
        <div className="flex flex-col gap-1.5">
          {changes.files.map((file) => (
            <div key={file.path} className="flex items-baseline gap-2 text-[11px]">
              <Badge variant="outline" className="shrink-0 text-[9px]">
                {fileStatusLabel(lang, file.status)}
              </Badge>
              <span className="truncate font-mono text-[11px]">{file.path}</span>
              <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
                {file.added > 0 ? `+${file.added}` : ""}
                {file.removed > 0 ? ` −${file.removed}` : ""}
              </span>
            </div>
          ))}
          <div className="mt-1">
            <DiffView text={changes.diff} open={changes.files.length <= 3} />
          </div>
        </div>
      </ScrollArea>
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
