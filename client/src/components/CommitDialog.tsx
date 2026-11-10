import { useState } from "react";
import { Check, GitCommitHorizontal } from "lucide-react";
import { toast } from "sonner";
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
import { Input } from "@/components/ui/input";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/** Commit the workspace as a checkpoint; the message is the only input. */
export function CommitDialog({ files, iconOnly = false }: { files: number; iconOnly?: boolean }) {
  const { lang, commit, loadChanges } = useStore();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function run() {
    setPending(true);
    try {
      const head = await commit(message);
      toast.success(`${tr(lang, "committed")} ${head}`);
      setOpen(false);
      setMessage("");
    } catch {
      toast.error(tr(lang, "nothingToCommit"));
      await loadChanges().catch(() => {});
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size={iconOnly ? "icon-xs" : "xs"} title={tr(lang, "commit")}>
          <GitCommitHorizontal className="size-3" />
          {iconOnly ? null : tr(lang, "commit")}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-sm">{tr(lang, "commit")}</DialogTitle>
          <DialogDescription className="text-xs">
            {files} {tr(lang, "diffSummary")}
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder={tr(lang, "commitMessage")}
          className="text-[13px]"
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void run();
            }
          }}
        />
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm">
              {lang === "zh" ? "取消" : "Cancel"}
            </Button>
          </DialogClose>
          <Button size="sm" onClick={() => void run()} disabled={pending}>
            <Check className="size-3.5" />
            {tr(lang, "commit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
