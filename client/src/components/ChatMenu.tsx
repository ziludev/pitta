import { useState } from "react";
import { Archive, ArchiveRestore, Eraser, MoreHorizontal, Pencil } from "lucide-react";
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
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * A session's own actions. Feishu chats and client chats both need tidying: rename
 * what the auto-title got wrong, archive what is done, and drop the checkout of a
 * conversation whose branch was merged.
 */
export function ChatMenu({
  conversationId,
  title,
  archived,
}: {
  conversationId: number;
  title: string;
  archived: boolean;
}) {
  const { lang, renameChat, archiveChat, cleanupWorktree } = useStore();
  const [renaming, setRenaming] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [draft, setDraft] = useState(title);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="shrink-0 opacity-0 group-hover:opacity-100 aria-expanded:opacity-100"
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40" onClick={(event) => event.stopPropagation()}>
          <DropdownMenuItem
            onSelect={() => {
              setDraft(title);
              setRenaming(true);
            }}
          >
            <Pencil className="size-3" />
            {tr(lang, "rename")}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void archiveChat(conversationId, !archived)}>
            {archived ? <ArchiveRestore className="size-3" /> : <Archive className="size-3" />}
            {archived ? tr(lang, "unarchive") : tr(lang, "archive")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem variant="destructive" onSelect={() => setCleaning(true)}>
            <Eraser className="size-3" />
            {tr(lang, "cleanupWorktree")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={renaming} onOpenChange={setRenaming}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{tr(lang, "rename")}</DialogTitle>
            <DialogDescription className="text-xs">{tr(lang, "renameHint")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void renameChat(conversationId, draft).then(() => setRenaming(false));
            }}
            className="text-[13px]"
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                {tr(lang, "cancel")}
              </Button>
            </DialogClose>
            <Button size="sm" onClick={() => void renameChat(conversationId, draft).then(() => setRenaming(false))}>
              {tr(lang, "save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cleaning} onOpenChange={setCleaning}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">{tr(lang, "cleanupWorktree")}</DialogTitle>
            <DialogDescription className="text-xs">{tr(lang, "cleanupHint")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                {tr(lang, "cancel")}
              </Button>
            </DialogClose>
            <Button
              variant="destructive"
              size="sm"
              onClick={async () => {
                const result = await cleanupWorktree(conversationId);
                if (result.status === "unmerged") {
                  // The only copy of that work is the worktree; say so instead of deleting.
                  toast.error(`${tr(lang, "unmergedWork")} · ${result.commits}`);
                  return;
                }
                toast(result.status === "removed" ? tr(lang, "cleaned") : tr(lang, "nothingToClean"));
                setCleaning(false);
              }}
            >
              <Eraser className="size-3.5" />
              {tr(lang, "cleanupWorktree")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
