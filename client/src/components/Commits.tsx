import { useState } from "react";
import { ArrowUpRight, ChevronRight, Copy, GitCommitHorizontal, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { EmptyState } from "@/components/ui/empty-state";
import { DiffView } from "@/lib/diff";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * The repository view the diff panel was missing: what this chat committed on top of
 * the project's base branch, with each commit's patch and a push that reports the
 * merge-request page (GitHub compare or GitLab MR form).
 */
/** Likely bases first (main/master/develop, then the current base), then the rest. */
function sortedBranches<T extends { name: string }>(branches: T[], base: string): T[] {
  const rank = (name: string): number => {
    if (name === base) return 0;
    if (/^(main|master)$/.test(name)) return 1;
    if (/^(develop|dev|release)$/.test(name)) return 2;
    return 3;
  };
  return [...branches].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
}

export function Commits() {
  const { lang, git, loadCommitDiff, pushBranch, commitDiffs, setGitBase } = useStore();
  const [open, setOpen] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [compare, setCompare] = useState<string | undefined>(git?.compareUrl);

  if (git === undefined) return <div className="p-3 text-[11px] text-muted-foreground">…</div>;

  async function expand(hash: string): Promise<void> {
    if (open === hash) {
      setOpen(undefined);
      return;
    }
    await loadCommitDiff(hash);
    setOpen(hash);
  }

  async function push(): Promise<void> {
    setBusy(true);
    try {
      const result = await pushBranch(false);
      if (result.status === "pushed") {
        setCompare(result.compareUrl);
        toast.success(`${tr(lang, "pushed")} ${result.branch}`);
      } else if (result.status === "no-remote") {
        toast.error(tr(lang, "noRemote"));
      } else if (result.status === "error") {
        toast.error(result.message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="min-w-0 shrink truncate font-mono text-[10.5px] text-muted-foreground" title={git.branch}>
          {git.branch}
        </span>
        <span className="shrink-0 text-[10.5px] text-muted-foreground">→</span>
        {/* The compare base is a choice: the chat may have been branched from any branch. */}
        <Select value={git.base} onValueChange={(branch) => void setGitBase(branch)}>
          <SelectTrigger
            size="sm"
            className="h-6 min-w-0 flex-1 justify-start gap-1 border-none bg-muted/40 px-1.5 font-mono text-[10.5px]"
            title={tr(lang, "baseBranchHint")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="max-h-72">
            {sortedBranches(git.branches, git.base).map((branch) => (
              <SelectItem key={branch.name} value={branch.name} className="font-mono text-[11px]">
                {branch.name}
                {branch.current ? " ✓" : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="ghost" size="icon-xs" title={tr(lang, "push")} disabled={busy} onClick={() => void push()}>
          <Upload className="size-3" />
        </Button>
      </div>

      {git.origin !== undefined && git.origin !== git.base ? (
        <div className="mx-3 mb-1.5 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1 text-[10px] text-amber-300/90">
          {tr(lang, "baseChangedHint").replace("{origin}", git.origin)}
        </div>
      ) : null}

      {compare !== undefined ? (
        <button
          onClick={() => {
            void navigator.clipboard?.writeText(compare);
            toast(tr(lang, "copied"));
          }}
          className="mx-3 mb-2 flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/5 px-2 py-1.5 text-left text-[10.5px] text-primary"
          title={compare}
        >
          <ArrowUpRight className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {git.remote.kind === "github" ? tr(lang, "openPr") : tr(lang, "openMr")} · {tr(lang, "clickToCopy")}
          </span>
          <Copy className="size-3 shrink-0" />
        </button>
      ) : null}

      {git.commits.length === 0 ? (
        <EmptyState title={tr(lang, "noCommits")} hint={tr(lang, "noCommitsHint")} />
      ) : (
        <ScrollArea className="min-h-0 flex-1 px-3 pb-2 [&_[data-radix-scroll-area-viewport]>div]:!block">
          <div className="flex flex-col gap-1">
            {git.commits.map((commit) => (
              <div key={commit.hash} className="rounded-md border border-border/60">
                <button
                  onClick={() => void expand(commit.hash)}
                  className="flex w-full items-start gap-1.5 px-2 py-1.5 text-left hover:bg-accent/10"
                >
                  <ChevronRight
                    className={cn("mt-0.5 size-3 shrink-0 text-muted-foreground transition-transform", open === commit.hash && "rotate-90")}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11.5px]">{commit.subject}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">
                      <GitCommitHorizontal className="mr-1 inline size-2.5" />
                      {commit.short} · {commit.date.slice(0, 10)} · {commit.files} {tr(lang, "files")}
                    </span>
                  </span>
                  <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">
                    {commit.added > 0 ? `+${commit.added}` : ""}
                    {commit.removed > 0 ? ` −${commit.removed}` : ""}
                  </span>
                </button>
                {open === commit.hash ? (
                  <div className="border-t border-border/60 p-2">
                    {commitDiffs[commit.hash] === undefined ? (
                      <div className="text-[11px] text-muted-foreground">…</div>
                    ) : (
                      <DiffView text={commitDiffs[commit.hash]!} open />
                    )}
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
