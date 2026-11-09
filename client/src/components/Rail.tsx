import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Database, FileText, GripVertical, Languages, RotateCw } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { tr } from "@/i18n";
import type { Surface, Task } from "@/lib/api";
import { useStore } from "@/store";

function surfaceLabel(surfaceId: string, feishu: string): string {
  return surfaceId.startsWith("oc_") ? `${feishu} ${surfaceId.slice(3, 9)}` : surfaceId;
}

function SessionRow({
  surface,
  active,
  label,
  onSelect,
}: {
  surface: Surface;
  active: boolean;
  label: string;
  onSelect: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: surface.conversationId,
  });
  return (
    <div
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      className={`group flex items-center gap-1 rounded-md px-1.5 py-1 text-xs ${
        active ? "bg-accent/15 text-foreground" : "hover:bg-accent/10"
      } ${isDragging ? "opacity-60" : ""}`}
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
    </div>
  );
}

export function Rail() {
  const { lang, surfaces, tasks, current, order, connection, busy, home, select, setOrder, control, openLogs, setLang } =
    useStore();
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const sorted = [...surfaces].sort((a, b) => {
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
    setOrder(arrayMove(ids, from, to));
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

      <div className="px-2.5 pt-3 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {tr(lang, "sessions")}
      </div>
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
                  label={surfaceLabel(surface.surfaceId, tr(lang, "feishu"))}
                  onSelect={() => void select(surface.conversationId)}
                />
              ))}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>

      <div className="px-2.5 pt-2 pb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {tr(lang, "running")}
      </div>
      <div className="min-h-0 max-h-40 overflow-y-auto px-2.5 pb-2">
        {liveTasks.length === 0 ? (
          <div className="text-[11px] text-muted-foreground">{tr(lang, "noTasks")}</div>
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
