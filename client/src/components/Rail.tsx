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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChatMenu } from "@/components/ChatMenu";
import { EmptyState } from "@/components/ui/empty-state";
import { cssEase, easeOutCubic, hoverLift } from "@/lib/motion";
import { tr } from "@/i18n";
import type { Surface, Task } from "@/lib/api";
import { useStore } from "@/store";

function surfaceLabel(surfaceId: string, feishu: string): string {
  return surfaceId.startsWith("oc_") ? `${feishu} ${surfaceId.slice(3, 9)}` : surfaceId;
}

function SessionRow({
  surface,
  active,
  pinned,
  kind,
  label,
  archived,
  pinTitle,
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
      className={`group flex items-center gap-1.5 overflow-hidden rounded-md px-2 py-1.5 text-xs whitespace-nowrap transition-[transform,box-shadow,background-color] ${
        active
          ? "bg-accent/15 text-foreground"
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
      <button
        {...attributes}
        {...listeners}
        className="cursor-grab text-muted-foreground/40 opacity-0 transition group-hover:opacity-100"
        aria-label="drag"
      >
        <GripVertical className="size-3" />
      </button>
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden text-left">
        {kind === "client" ? (
          <Monitor className="size-2.5 shrink-0 text-primary/70" />
        ) : kind === "feishu" ? (
          <MessagesSquare className="size-2.5 shrink-0 text-muted-foreground/60" />
        ) : null}
        <span className={`min-w-0 flex-1 truncate ${archived ? "text-muted-foreground/60 line-through" : ""}`}>
          {label}
        </span>
        <span className="shrink-0 text-[10px] text-muted-foreground/50 tabular-nums opacity-0 group-hover:opacity-100">
          #{surface.conversationId}
        </span>
      </button>
      <ChatMenu conversationId={surface.conversationId} title={label} archived={archived} />
      <button
        onClick={onTogglePin}
        title={pinTitle}
        className={`shrink-0 transition ${
          pinned ? "text-primary" : "text-muted-foreground/40 opacity-0 group-hover:opacity-100"
        }`}
      >
        {pinned ? <Pin className="size-3" /> : <PinOff className="size-3" />}
      </button>
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
    newChat,
    showArchived,
    toggleShowArchived,
    select,
    setOrder,
    togglePin,
    control,
    openLogs,
    setLang,
  } = useStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const kindOf = (surface: Surface): string =>
    surface.kind ?? (surface.surfaceId.startsWith("oc_") ? "feishu" : surface.surfaceId.startsWith("client:") ? "client" : "other");
  const scoped = surfaceFilter === "all" ? surfaces : surfaces.filter((surface) => kindOf(surface) === surfaceFilter);
  const visible = (showArchived ? scoped : scoped.filter((surface) => surface.archived !== true)).filter((surface) => {
    if (filter.trim().length === 0) return true;
    const needle = filter.trim().toLowerCase();
    return surface.surfaceId.toLowerCase().includes(needle) || String(surface.conversationId).includes(needle);
  });
  const sorted = [...visible].sort((a, b) => {
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

  const liveTasks = tasks.filter((task) => !task.kind.startsWith("pi."));

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
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
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

      <div className="flex items-center justify-between px-2.5 pt-3 pb-1">
        <span className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {tr(lang, "sessions")}
        </span>
        <Button variant="ghost" size="icon-xs" title={tr(lang, "newChat")} onClick={() => void newChat()}>
          <Plus className="size-3" />
        </Button>
      </div>
      <div className="mb-1.5 flex items-center gap-1 px-2">
        <Select value={surfaceFilter} onValueChange={(next) => setSurfaceFilter(next as typeof surfaceFilter)}>
          <SelectTrigger size="sm" className="h-6 flex-1 border-none bg-muted/40 px-2 text-[10.5px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all" className="text-[11px]">
              {tr(lang, "allChats")} · {surfaces.length}
            </SelectItem>
            <SelectItem value="client" className="text-[11px]">
              {tr(lang, "clientChats")} · {surfaces.filter((surface) => kindOf(surface) === "client").length}
            </SelectItem>
            <SelectItem value="feishu" className="text-[11px]">
              {tr(lang, "feishuChats")} · {surfaces.filter((surface) => kindOf(surface) === "feishu").length}
            </SelectItem>
          </SelectContent>
        </Select>
        <Button
          variant={showArchived ? "secondary" : "ghost"}
          size="icon-xs"
          onClick={toggleShowArchived}
          title={tr(lang, "archived")}
        >
          <Archive className="size-3" />
        </Button>
      </div>
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
              {sorted.map((surface) => (
                <SessionRow
                  key={surface.conversationId}
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

      <Separator className="mx-2.5" />
      <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {tr(lang, "running")}
      </div>
      <div className="min-h-0 max-h-40 overflow-y-auto px-2.5 pb-2">
        {liveTasks.length === 0 ? (
          <div className="py-2 text-[11px] text-muted-foreground">{tr(lang, "noTasks")}</div>
        ) : (
          liveTasks.map((task: Task) => (
            <div key={task.id} className="flex items-baseline justify-between gap-2 py-0.5 text-[11px]">
              <span className="truncate">{task.kind}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                #{task.id} {task.state}
              </Badge>
            </div>
          ))
        )}
      </div>

      <div className="mt-auto flex flex-col gap-2 border-t border-border p-2.5">
        <div className="flex gap-1.5">
          <Button
            variant="outline"
            size="xs"
            title="agentctl restart"
            onClick={async () => {
              const output = await control("restart");
              toast(output.split("\n")[0] || tr(lang, "restart"));
            }}
          >
            <RotateCw className="size-3" />
            {tr(lang, "restart")}
          </Button>
          <Button
            variant="outline"
            size="xs"
            title="agentctl backup"
            onClick={async () => {
              const output = await control("backup");
              toast(output.split("\n")[0] || tr(lang, "backup"));
            }}
          >
            <Database className="size-3" />
            {tr(lang, "backup")}
          </Button>
          <Button variant="outline" size="xs" title="open logs" onClick={() => void openLogs()}>
            <FileText className="size-3" />
            {tr(lang, "logs")}
          </Button>
        </div>
        <div className="truncate text-[10px] text-muted-foreground">{home}</div>
      </div>
    </div>
  );
}
