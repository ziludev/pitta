import { useEffect, useState } from "react";
import { Check, ChevronsUpDown, FolderGit2, FolderPlus, Trash2 } from "lucide-react";
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

const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+\//, "~/");

/**
 * Project switcher. A project is a repo the agent may work in; chats inside it get
 * their own worktree. Shown as a menu (name + path, current one checked) because a
 * select renders the path next to the name twice and reads like a bug.
 */
export function ProjectBar() {
  const { lang, projects, currentProject, setProject, openProject, removeProject } = useStore();
  const [opening, setOpening] = useState(false);
  // ?projects=1 opens the switcher (screenshots, demos).
  const [menu, setMenu] = useState(new URLSearchParams(location.search).get("projects") === "1");
  const [path, setPath] = useState("");
  const [busy, setBusy] = useState(false);
  // Removing a project is not undoable from the UI, so it asks first and names the repo.
  const [removing, setRemoving] = useState<{ id: string; name: string } | undefined>(undefined);
  const demosRemoval = new URLSearchParams(location.search).get("removeProject") === "1";

  const current = projects.find((project) => project.id === currentProject) ?? projects[0];

  // ?removeProject=1 opens the confirm dialog once the list has arrived (demos).
  useEffect(() => {
    if (!demosRemoval || removing !== undefined) return;
    const target = projects.find((project) => project.builtin !== true);
    if (target !== undefined) setRemoving({ id: target.id, name: target.name });
  }, [demosRemoval, projects, removing]);

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
    <div className="px-2 pt-2">
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            className="h-8 w-full justify-start gap-1.5 px-2 text-[11.5px] font-medium hover:bg-accent/10"
          >
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left">{current?.name ?? tr(lang, "project")}</span>
            <ChevronsUpDown className="size-3 shrink-0 text-muted-foreground/60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {projects.map((project) => (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => setProject(project.id)}
              className="group/item gap-2"
            >
              <Check
                className={`size-3 shrink-0 ${project.id === current?.id ? "text-primary" : "text-transparent"}`}
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[11.5px]">{project.name}</span>
                <span className="block truncate text-[10px] text-muted-foreground">
                  {shortPath(project.path)}
                  {project.builtin === true ? ` · ${tr(lang, "builtin")}` : ""}
                </span>
              </span>
              {project.builtin === true ? null : (
                <button
                  title={tr(lang, "removeProject")}
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setRemoving({ id: project.id, name: project.name });
                    setMenu(false);
                  }}
                  className="shrink-0 rounded p-0.5 text-muted-foreground/30 transition hover:text-rose-400"
                >
                  <Trash2 className="size-3" />
                </button>
              )}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => setOpening(true)} className="gap-2">
            <FolderPlus className="size-3" />
            {tr(lang, "openProject")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={removing !== undefined} onOpenChange={(next) => (next ? undefined : setRemoving(undefined))}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle className="text-sm">
              {tr(lang, "removeProject")} · {removing?.name}
            </DialogTitle>
            <DialogDescription className="text-xs">{tr(lang, "removeProjectHint")}</DialogDescription>
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
              onClick={() => {
                const target = removing;
                setRemoving(undefined);
                if (target === undefined) return;
                void removeProject(target.id).then((result) => {
                  toast(
                    result.movedChats !== undefined && result.movedChats > 0
                      ? `${tr(lang, "projectRemoved")} · ${result.movedChats} ${tr(lang, "chatsMoved")}`
                      : tr(lang, "projectRemoved"),
                  );
                });
              }}
            >
              <Trash2 className="size-3.5" />
              {tr(lang, "remove")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
