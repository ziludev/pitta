import { useState } from "react";
import { toast } from "sonner";
import { AlertTriangle, GitMerge } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/** Merges this conversation's branch back into the main branch, refusing to guess. */
export function MergeButton({ iconOnly = false }: { iconOnly?: boolean }) {
  const { lang, changes, merge, askAgentToResolve, commit } = useStore();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [conflicts, setConflicts] = useState<string[] | undefined>();

  const branch = changes?.branch ?? "";
  const dirty = (changes?.files.length ?? 0) > 0;

  async function run() {
    setBusy(true);
    try {
      const result = await merge();
      if (result.status === "merged") {
        toast.success(`${result.branch} → ${result.base} · ${result.commits}`);
        setOpen(false);
      } else if (result.status === "up-to-date") {
        toast(`${result.branch} · ${tr(lang, "nothingToMerge")}`);
        setOpen(false);
      } else if (result.status === "dirty") {
        toast.error(tr(lang, "commitFirst"));
      } else if (result.status === "main-dirty") {
        toast.error(`${tr(lang, "mainDirty")}: ${result.files.slice(0, 3).join(", ")}`);
      } else if (result.status === "conflict") {
        setConflicts(result.conflicts);
      } else {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setConflicts(undefined);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="ghost" size={iconOnly ? "icon-xs" : "xs"} title={tr(lang, "merge")}>
          <GitMerge className="size-3" />
          {iconOnly ? null : tr(lang, "merge")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{tr(lang, "merge")}</DialogTitle>
          <DialogDescription className="text-xs">
            {branch} → {changes?.branch?.startsWith("agent/") ? tr(lang, "mainBranch") : ""}
          </DialogDescription>
        </DialogHeader>

        {conflicts === undefined ? (
          <div className="text-xs text-muted-foreground">
            {dirty ? tr(lang, "commitFirst") : tr(lang, "mergeHint")}
          </div>
        ) : (
          <div className="flex flex-col gap-1 text-xs">
            <div className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
              <AlertTriangle className="size-3.5" />
              {tr(lang, "conflictIn")}
            </div>
            <ul className="ml-4 list-disc font-mono text-[11px] text-muted-foreground">
              {conflicts.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {lang === "zh" ? "取消" : "Cancel"}
            </Button>
          </DialogClose>
          {conflicts !== undefined ? (
            <Button
              size="sm"
              onClick={async () => {
                await askAgentToResolve({ status: "conflict", branch, base: "", conflicts });
                toast(tr(lang, "askedAgent"));
                setOpen(false);
              }}
            >
              {tr(lang, "askAgent")}
            </Button>
          ) : (
            <Button size="sm" onClick={() => void run()} disabled={busy || dirty}>
              <GitMerge className="size-3.5" />
              {tr(lang, "merge")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
