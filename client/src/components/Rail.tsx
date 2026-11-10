import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Database, FileText, GripVertical, Languages, Pin, PinOff, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { ThemeToggle } from "@/components/ThemeToggle";
import { SearchBox } from "@/components/SearchBox";
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
  label,
  pinTitle,
  onSelect,
  onTogglePin,
}: {
  surface: Surface;
  active: boolean;
  pinned: boolean;
  label: string;
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
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-[transform,box-shadow,background-color] ${
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
      <button onClick={onSelect} className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left">
        <span className="truncate">{label}</span>
        <span className="shrink-0 text-[10px] text-muted-foreground tabular-nums">#{surface.conversationId}</span>
      </button>
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
    onlyFeishu,
    toggleOnlyFeishu,
    select,
    setOrder,
    togglePin,
    control,
    openLogs,
    setLang,
  } = useStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // Test conversations (cli, remtest, …) have no chat id; they clutter the rail.
  const visible = (onlyFeishu ? surfaces.filter((surface) => surface.surfaceId.startsWith("oc_")) : surfaces).filter((surface) => {
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
        <button
          onClick={toggleOnlyFeishu}
          className={`text-[10px] ${onlyFeishu ? "text-primary" : "text-muted-foreground/60 hover:text-foreground"}`}
        >
          {tr(lang, "hideTests")}
        </button>
      </div>
      <SearchBox />
      <ScrollArea className="min-h-0 flex-1 px-1.5">
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
                  label={surfaceLabel(surface.surfaceId, tr(lang, "feishu"))}
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
