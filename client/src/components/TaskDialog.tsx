import { useEffect } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * One task, opened from 运行中. A running pipeline or a sleeping reminder answers three questions
 * here — what it is, what it was asked, and where it lives — and can be cancelled from the same
 * place instead of asking the model to call `cancel_task`.
 */

const KIND_LABEL: Record<string, string> = {
  "app.feature": "需求流水线",
  "app.reminder": "定时提醒",
  "app.usage-sampler": "用量采样",
  "pi.generation": "模型请求",
};

const STATUS_LABEL: Record<string, string> = {
  pending: "排队中",
  running: "运行中",
  waiting: "等待中",
  sleeping: "休眠",
  completing: "收尾",
  terminal: "已结束",
};

function clock(at: number): string {
  return new Date(at).toLocaleString("zh-CN", { hour12: false, month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

/** What the task was asked, in one paragraph: the spec for a pipeline, the text for a reminder. */
function askedOf(input: unknown): string {
  const value = (input ?? {}) as { spec?: string; text?: string };
  return value.spec ?? value.text ?? "";
}

export function TaskDialog() {
  const { lang, taskDetail, closeTask, cancelTask, select } = useStore();

  // `?task=<id>` opens one directly (screenshots, demos).
  const { openTask } = useStore();
  useEffect(() => {
    const id = Number(new URLSearchParams(location.search).get("task"));
    if (Number.isFinite(id) && id > 0) void openTask(id).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = taskDetail !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : closeTask())}>
      <DialogContent className="sm:max-w-[520px]">
        {taskDetail === null ? null : (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-[14px]">
                <span
                  className={`size-2 rounded-full ${
                    taskDetail.status === "running"
                      ? "animate-pulse bg-emerald-400"
                      : taskDetail.status === "terminal"
                        ? "bg-muted-foreground/40"
                        : "bg-amber-400"
                  }`}
                />
                {KIND_LABEL[taskDetail.kind] ?? taskDetail.kind} · #{taskDetail.id}
              </DialogTitle>
              <DialogDescription className="text-[11px]">
                {STATUS_LABEL[taskDetail.status] ?? taskDetail.status}
                {taskDetail.phase === null ? "" : ` · 阶段 ${taskDetail.phase}`}
                {taskDetail.until === null ? "" : ` · ${clock(taskDetail.until)} 唤醒`}
                {` · 会话 #${taskDetail.conversationId}`}
                {taskDetail.background ? " · 后台" : ""}
                {taskDetail.abortRequested ? " · 正在取消" : ""}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-2 text-[12px]">
              <div className="rounded-lg border border-border/60 bg-muted/20 p-2.5 leading-relaxed">
                {taskDetail.title === undefined || taskDetail.title.length === 0 ? "（没有说明）" : taskDetail.title}
              </div>
              {askedOf(taskDetail.input).length > 0 ? (
                <div className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-border/40 p-2.5 text-[11px] leading-relaxed text-muted-foreground">
                  {askedOf(taskDetail.input).slice(0, 2_000)}
                </div>
              ) : null}
              {taskDetail.outcome === null ? null : (
                <pre className="max-h-32 overflow-auto rounded-lg border border-border/40 p-2 text-[10px] text-muted-foreground">
                  {JSON.stringify(taskDetail.outcome, null, 1).slice(0, 800)}
                </pre>
              )}
            </div>

            <div className="mt-1 flex items-center justify-end gap-1.5">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  void select(taskDetail.conversationId);
                  closeTask();
                }}
              >
                {tr(lang, "sessions")} #{taskDetail.conversationId}
              </Button>
              <Button
                variant="outline"
                size="xs"
                className="text-rose-500"
                disabled={taskDetail.status === "terminal"}
                onClick={() => {
                  void cancelTask(taskDetail.id).catch(() => {});
                }}
              >
                取消任务
              </Button>
              <Button size="xs" onClick={closeTask}>
                知道了
              </Button>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
