import { useState } from "react";
import { FolderPlus, FolderGit2 } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * A project is a repo the agent may work in; chats inside it get their own worktree.
 * The rail is scoped to one project at a time (ThinkRail's project → workspace → chats).
 */
export function ProjectBar() {
  const { lang, projects, currentProject, setProject, openProject } = useStore();
  const [opening, setOpening] = useState(false);
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);

  const current = projects.find((project) => project.id === currentProject) ?? projects[0];

  async function open(): Promise<void> {
    if (path.trim().length === 0) return;
    setBusy(true);
    try {
      const result = await openProject(path.trim());
      if (result.status === "added" || result.status === "exists") {
        toast(`${tr(lang, "projectOpened")} · ${result.project?.name ?? path}`);
        setOpening(false);
        setPath("");
      } else if (result.status === "not-a-repo") {
        toast.error(tr(lang, "notARepo"));
      } else if (result.status === "missing") {
        toast.error(tr(lang, "pathMissing"));
      } else {
        toast.error(result.status);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex items-center gap-1 px-2 pt-2">
      <Select value={current?.id ?? ""} onValueChange={setProject}>
        <SelectTrigger size="sm" className="h-7 flex-1 gap-1.5 border-none bg-muted/40 px-2 text-[11px]">
          <FolderGit2 className="size-3 shrink-0 text-muted-foreground" />
          <SelectValue placeholder={tr(lang, "project")} />
        </SelectTrigger>
        <SelectContent>
          {projects.map((project) => (
            <SelectItem key={project.id} value={project.id} className="text-[11px]">
              <span className="truncate">{project.name}</span>
              {project.path.replace(/\/[^/]+$/, "").split("/").pop() !== project.name ? null : (
                <span className="ml-1 truncate text-[10px] text-muted-foreground">
                  {project.path.replace(/^\/Users\/[^/]+\//, "~/")}
                </span>
              )}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="ghost" size="icon-xs" title={tr(lang, "openProject")} onClick={() => setOpening(true)}>
        <FolderPlus className="size-3" />
      </Button>

      <Dialog open={opening} onOpenChange={setOpening}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-sm">{tr(lang, "openProject")}</DialogTitle>
            <DialogDescription className="text-xs">{tr(lang, "openProjectHint")}</DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder="~/work/example-service"
            className="text-[13px]"
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void open();
            }}
          />
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm">
                {tr(lang, "cancel")}
              </Button>
            </DialogClose>
            <Button size="sm" disabled={busy} onClick={() => void open()}>
              <FolderGit2 className="size-3.5" />
              {tr(lang, "open")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
