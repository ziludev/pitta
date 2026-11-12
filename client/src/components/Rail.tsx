import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Archive,
  Database,
  FileText,
  GripVertical,
  Languages,
  MessagesSquare,
  Monitor,
  Pin,
  PinOff,
  Plus,
  RotateCw,
} from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SearchBox } from "@/components/SearchBox";
import { CornerDownRight, PlugZap } from "lucide-react";
import { ProjectBar } from "@/components/ProjectBar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatMenu } from "@/components/ChatMenu";
import { EmptyState } from "@/components/ui/empty-state";
import { cssEase, easeOutCubic, hoverLift } from "@/lib/motion";
import { tr } from "@/i18n";
import type { Surface, Task } from "@/lib/api";
import { useStore } from "@/store";

const TASK_LABELS: Record<string, Record<string, string>> = {
  "app.feature": { zh: "需求流水线", en: "Feature pipeline" },
  "app.reminder": { zh: "定时提醒", en: "Reminder" },
};

const STATE_LABELS: Record<string, Record<string, string>> = {
  pending: { zh: "排队中", en: "queued" },
  running: { zh: "运行中", en: "running" },
  waiting: { zh: "等待中", en: "waiting" },
  sleeping: { zh: "休眠", en: "sleeping" },
  completing: { zh: "收尾", en: "finishing" },
};

/** Traffic-light dot: green = working, amber = queued/asleep, red = needs a look. */
const TASK_DOT: Record<string, string> = {
  running: "bg-emerald-400",
  completing: "bg-emerald-400",
  pending: "bg-amber-400",
  waiting: "bg-amber-400",
  sleeping: "bg-amber-400",
  blocked: "bg-rose-500",
  faulted: "bg-rose-500",
};

/** "13:20" today, "明天 09:00" tomorrow, "12-01 09:00" further out. */
function formatWhen(lang: "zh" | "en", until: number): string {
  const at = new Date(until);
  const now = new Date();
  const time = at.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  if (until - now.getTime() < 60_000) return lang === "zh" ? "即将" : "soon";
  const sameDay = at.toDateString() === now.toDateString();
  if (sameDay) return time;
  const tomorrow = new Date(now.getTime() + 86_400_000);
  if (at.toDateString() === tomorrow.toDateString()) return lang === "zh" ? `明天 ${time}` : `tomorrow ${time}`;
  return `${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")} ${time}`;
}

function taskLabel(lang: "zh" | "en", kind: string): string {
  return TASK_LABELS[kind]?.[lang] ?? kind;
}

function taskState(lang: "zh" | "en", state: string): string {
  return STATE_LABELS[state]?.[lang] ?? state;
}

function surfaceLabel(surfaceId: string, feishu: string): string {
  return surfaceId.startsWith("oc_") ? `${feishu} ${surfaceId.slice(3, 9)}` : surfaceId;
}

/** Two decimals keeps the column narrow; a tenth of a cent is not a decision input. */
const money = (cost: number): string => `$${cost < 1 ? cost.toFixed(2) : cost.toFixed(1)}`;

function SessionRow({
  surface,
  active,
  pinned,
  kind,
  label,
  archived,
  pinTitle,
  topic,
  onSelect,
  onTogglePin,
}: {
  surface: Surface;
  active: boolean;
  pinned: boolean;
  kind: string;
  label: string;
  archived: boolean;
  pinTitle: string;
  /** A topic fork: nested under its chat, marked so the nesting reads on purpose. */
  topic: boolean;
  onSelect: () => void;
  onTogglePin: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.conversationId,
  });
  // #081 hover lift: the spec's 10px would occlude the neighbouring row in a 22px
  // list, so the row rises 2px and keeps the shadow character.
  return (
    <div
      ref={setNodeRef}
      className={`group/row relative flex items-center overflow-hidden rounded-md py-1 pr-1.5 text-[11.5px] whitespace-nowrap transition-[transform,box-shadow,background-color] ${
        active
          ? "bg-accent/25 font-medium text-foreground"
          : "hover:-translate-y-[2px] hover:bg-accent/10 hover:shadow-[0_6px_14px_-6px_rgba(0,0,0,0.45)]"
      } ${isDragging ? "opacity-60" : ""}`}
      style={{
        transform: CSS.Transform.toString(transform),
        transition,
        // #081 timing applies to the hover lift; dnd-kit overrides it while dragging.
        transitionDuration: `${hoverLift.duration}s`,
        transitionTimingFunction: cssEase(easeOutCubic),
      }}
    >
      {/* The handle, the pin and the menu appear on hover: reserving their width kept the title
          down to half the rail, which read as a list of cut-off sentences. */}
      {active ? (
        <span aria-hidden className="absolute top-1/2 left-0 h-3.5 w-[2px] -translate-y-1/2 rounded-full bg-primary" />
      ) : null}
      <button
        {...attributes}
        {...listeners}
        className="flex w-0 shrink-0 cursor-grab items-center justify-center overflow-hidden text-muted-foreground/40 transition-all group-hover/row:w-3.5"
        aria-label="drag"
      >
        <GripVertical className="size-3" />
      </button>
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 pl-2 pr-1 text-left">
        {topic ? (
          <CornerDownRight className="size-2.5 shrink-0 text-muted-foreground/50" />
        ) : kind === "client" ? (
          <Monitor className="size-2.5 shrink-0 text-primary/70" />
        ) : kind === "feishu" ? (
          <MessagesSquare className="size-2.5 shrink-0 text-muted-foreground/60" />
        ) : null}
        <span className={`min-w-0 flex-1 truncate ${archived ? "text-muted-foreground/60 line-through" : ""}`}>
          {label}
        </span>
        {surface.cost !== undefined && surface.cost >= 0.005 ? (
          <span className="shrink-0 text-[10px] text-muted-foreground/60 tabular-nums" title={money(surface.cost)}>
            {money(surface.cost)}
          </span>
        ) : null}
      </button>
      <div className="absolute top-1/2 right-1 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-background/95 px-1 opacity-0 shadow-sm transition group-hover/row:opacity-100">
        <span className="text-[9.5px] text-muted-foreground/60 tabular-nums">#{surface.conversationId}</span>
        <ChatMenu conversationId={surface.conversationId} title={label} archived={archived} />
        <button
          onClick={onTogglePin}
          title={pinTitle}
          className={`shrink-0 transition ${pinned ? "text-primary" : "text-muted-foreground/50 hover:text-foreground"}`}
        >
          {pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
        </button>
      </div>
      {pinned ? (
        <Pin className="pointer-events-none absolute top-1 right-1 size-2.5 text-primary/70 group-hover/row:opacity-0" />
      ) : null}
    </div>
  );
}

export function Rail() {
  const {
    lang,
    surfaces,
    tasks,
    current,
    order,
    pinned,
    connection,
    busy,
    home,
    filter,
    surfaceFilter,
    setSurfaceFilter,
    feishu,
    currentProject,
    projects,
    setProject,
    newChat,
    showArchived,
    toggleShowArchived,
    select,
    setOrder,
    togglePin,
    control,
    openTask,
    openLogs,
    setLang,
  } = useStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const kindOf = (surface: Surface): string =>
    surface.kind ?? (surface.surfaceId.startsWith("oc_") ? "feishu" : surface.surfaceId.startsWith("client:") ? "client" : "other");
  // Rail is scoped to one project: the builtin sandbox unless the owner opened a repo.
  const inProject = surfaces.filter((surface) => (surface.projectId ?? "workspace") === currentProject);
  const scoped = surfaceFilter === "all" ? inProject : inProject.filter((surface) => kindOf(surface) === surfaceFilter);
  const visibleBase = (showArchived ? scoped : scoped.filter((surface) => surface.archived !== true)).filter((surface) => {
    if (filter.trim().length === 0) return true;
    const needle = filter.trim().toLowerCase();
    return surface.surfaceId.toLowerCase().includes(needle) || String(surface.conversationId).includes(needle);
  });
  const sorted = [...visibleBase].sort((a, b) => {
    const ap = pinned.indexOf(a.conversationId);
    const bp = pinned.indexOf(b.conversationId);
    if (ap !== -1 || bp !== -1) {
      if (ap === -1) return 1;
      if (bp === -1) return -1;
      return ap - bp;
    }
    const ai = order.indexOf(a.conversationId);
    const bi = order.indexOf(b.conversationId);
    if (ai !== -1 && bi !== -1) return ai - bi;
    return a.conversationId - b.conversationId;
  });

  // A topic fork shares its parent's chat, so it is shown under it instead of as another
  // conversation at the same level — otherwise a busy group fills the rail with topics.
  const present = new Set(sorted.map((surface) => surface.conversationId));
  const childrenOf = new Map<number, Surface[]>();
  for (const surface of sorted) {
    if (surface.threadParent === undefined || !present.has(surface.threadParent)) continue;
    const list = childrenOf.get(surface.threadParent) ?? [];
    list.push(surface);
    childrenOf.set(surface.threadParent, list);
  }
  const nested: Array<{ surface: Surface; topic: boolean }> = [];
  for (const surface of sorted) {
    if (surface.threadParent !== undefined && present.has(surface.threadParent)) continue;
    nested.push({ surface, topic: false });
    for (const child of childrenOf.get(surface.conversationId) ?? []) nested.push({ surface: child, topic: true });
  }

  // Every other project that has conversations, biggest first.
  const otherProjects = projects
    .filter((project) => project.id !== currentProject)
    .map((project) => ({
      id: project.id,
      name: project.name,
      count: surfaces.filter(
        (surface) => (surface.projectId ?? "workspace") === project.id && (showArchived || surface.archived !== true),
      ).length,
    }))
    .filter((entry) => entry.count > 0)
    .sort((left, right) => right.count - left.count);

  // Infrastructure tasks (usage sampling) and internal pi.* tasks are noise here:
  // the rail shows the work the owner started.
  const liveTasks = tasks.filter(
    (task) => task.kind.startsWith("app.") && task.kind !== "app.usage-sampler",
  );

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (over === null || active.id === over.id) return;
    const ids = sorted.map((surface) => surface.conversationId);
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from === -1 || to === -1) return;
    const moved = arrayMove(ids, from, to);
    setOrder(moved);
    // Dragging to the very top pins; dragging a pinned row down unpins it.
    const dragged = Number(active.id);
    if (to === 0) {
      if (!pinned.includes(dragged)) togglePin(dragged);
    } else if (pinned.includes(dragged)) {
      togglePin(dragged);
    }
  }

  const status =
    busy
      ? tr(lang, "busy")
      : connection === "open"
        ? tr(lang, "idle")
        : connection === "connecting"
          ? tr(lang, "connecting")
          : connection === "failed"
            ? tr(lang, "bridgeFailed")
            : tr(lang, "disconnected");

  return (
    <div className="flex h-full min-h-0 flex-col bg-card/40">
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <div>
          <div className="text-sm font-semibold tracking-tight">Agent</div>
          <div className={`text-[11px] ${busy ? "text-primary" : "text-muted-foreground"}`}>{status}</div>
        </div>
        <div className="flex items-center gap-0.5">
          <ThemeToggle />
          <Button
            variant="ghost"
            size="xs"
            title={tr(lang, "language")}
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
          >
            <Languages className="size-3" />
            {lang === "zh" ? "EN" : "中"}
          </Button>
        </div>
      </div>

      <ProjectBar />
      <div className="flex items-center gap-0.5 pl-2.5 pr-1.5 pt-1 pb-0.5">
        <span className="shrink-0 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {tr(lang, "sessions")}
        </span>
        <Select value={surfaceFilter} onValueChange={(next) => setSurfaceFilter(next as typeof surfaceFilter)}>
          <SelectTrigger
            size="sm"
            className="h-5 max-w-[96px] gap-0.5 border-none bg-transparent px-1 text-[10.5px] text-muted-foreground hover:bg-muted/40"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[11px]">
              {tr(lang, "allChats")} · {inProject.length}
            </SelectItem>
            <SelectItem value="client" className="text-[11px]">
              {tr(lang, "clientChats")} · {inProject.filter((surface) => kindOf(surface) === "client").length}
            </SelectItem>
            <SelectItem value="feishu" className="text-[11px]">
              {tr(lang, "feishuChats")} · {inProject.filter((surface) => kindOf(surface) === "feishu").length}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={showArchived ? "secondary" : "ghost"}
          size="icon-xs"
          className="ml-auto"
          onClick={toggleShowArchived}
          title={tr(lang, "archived")}
        >
          <Archive className="size-3" />
        </Button>
        <Button variant="ghost" size="icon-xs" title={tr(lang, "newChat")} onClick={() => void newChat()}>
          <Plus className="size-3" />
        </Button>
      </div>
      {feishu !== undefined && feishu.ready === false && feishu.downMs > 60_000 ? (
        <div
          className="mx-2 mb-1.5 flex items-center gap-1.5 rounded-md border border-rose-500/40 bg-rose-500/10 px-2 py-1 text-[10px] text-rose-300"
          title={feishu.lastError ?? tr(lang, "feishuDownHint")}
        >
          <PlugZap className="size-3 shrink-0" />
          <span className="min-w-0 flex-1 truncate">
            {tr(lang, "feishuDown")} {Math.round(feishu.downMs / 60_000)}m
          </span>
        </div>
      ) : null}
      <SearchBox />
      <ScrollArea className="min-h-0 w-full flex-1 px-1.5 [&_[data-radix-scroll-area-viewport]>div]:!block">
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={sorted.map((surface) => surface.conversationId)} strategy={verticalListSortingStrategy}>
            <div className="flex flex-col gap-0.5 pb-2">
              {nested.map(({ surface, topic }) => (
                <SessionRow
                  key={surface.conversationId}
                  topic={topic}
                  surface={surface}
                  active={surface.conversationId === current}
                  pinned={pinned.includes(surface.conversationId)}
                  kind={kindOf(surface)}
                  archived={surface.archived === true}
                  label={
                    surface.title !== undefined && surface.title.length > 0
                      ? surface.title
                      : kindOf(surface) === "client"
                        ? `${tr(lang, "newChat")} #${surface.conversationId}`
                        : surfaceLabel(surface.surfaceId, tr(lang, "feishu"))
                  }
                  pinTitle={tr(lang, "pinned")}
                  onSelect={() => void select(surface.conversationId)}
                  onTogglePin={() => togglePin(surface.conversationId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>

      {/* The rail lists one project at a time; this says what the others hold, so a project jump
          never looks like the list lost its conversations. */}
      {otherProjects.length === 0 ? null : (
        <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 border-t border-border/50 px-2.5 py-1 text-[10px] text-muted-foreground/70">
          <span className="shrink-0">{tr(lang, "otherProjects")}</span>
          {otherProjects.map((entry) => (
            <button
              key={entry.id}
              onClick={() => setProject(entry.id)}
              title={`切到 ${entry.name}（${entry.count} 个会话）`}
              className="shrink-0 rounded border border-border/50 px-1 tabular-nums transition hover:border-primary/40 hover:text-foreground"
            >
              {entry.name} {entry.count}
            </button>
          ))}
        </div>
      )}

      {liveTasks.length === 0 ? null : (
        <>
      <Separator className="mx-2.5" />
      <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {tr(lang, "running")}
      </div>
      <div className="min-h-0 max-h-40 overflow-y-auto px-2.5 pb-2">
        {liveTasks.map((task: Task) => (
            <button
              key={task.id}
              onClick={() => void openTask(task.id)}
              title="点开看详情"
              className="flex w-full items-center gap-1.5 rounded-md px-1 py-1 text-left text-[11px] transition hover:bg-accent/10"
            >
              <span
                className={`size-1.5 shrink-0 rounded-full ${TASK_DOT[task.state] ?? "bg-muted-foreground/40"} ${
                  task.state === "running" ? "animate-pulse" : ""
                }`}
                title={taskState(lang, task.state)}
              />
              <span className="min-w-0 flex-1 truncate" title={taskLabel(lang, task.kind)}>
                {task.title ?? taskLabel(lang, task.kind)}
              </span>
              <span className="shrink-0 text-[10px] text-muted-foreground/70">
                {task.until !== undefined && task.state === "sleeping"
                  ? formatWhen(lang, task.until)
                  : taskState(lang, task.state)}
              </span>
            </button>
        ))}
      </div>
        </>
      )}

      <div className="mt-auto flex flex-col gap-2 border-t border-border p-2.5">
        <div className="flex items-center gap-0.5">
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="agentctl restart"
            onClick={async () => {
              const output = await control("restart");
              toast(output.split("\n")[0] || tr(lang, "restart"));
            }}
          >
            <RotateCw className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="agentctl backup"
            onClick={async () => {
              const output = await control("backup");
              toast(output.split("\n")[0] || tr(lang, "backup"));
            }}
          >
            <Database className="size-3" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            title="open logs"
            onClick={() => void openLogs()}
          >
            <FileText className="size-3" />
          </Button>
          <span className="ml-auto min-w-0 truncate text-[9.5px] text-muted-foreground/50" title={home}>
            {home.replace(/^\/Users\/[^/]+\//, "~/")}
          </span>
        </div>
      </div>
    </div>
  );
}
