import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/i18n";
import type { AccessLevel, AuditEvent } from "@/lib/api";
import { useStore } from "@/store";

/**
 * Who may use which chat, and what was decided recently. The Feishu side decides this from
 * `app.chat-access`; until now the only way to see it was `durable access` in a terminal.
 */

const LEVEL_STYLE: Record<AccessLevel, string> = {
  group: "border-amber-500/40 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  owner: "border-emerald-500/40 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  closed: "border-border bg-muted/40 text-muted-foreground",
};

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  access: "级别",
  deny: "拦截",
  approve: "审批",
  query: "查询",
  report: "来访",
};

function when(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

export function AccessPanel() {
  const { lang, access, audit, loadAccess } = useStore();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAccess().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-1 px-3 py-2 text-[11px] text-muted-foreground">
        <span className="truncate">{tr(lang, "accessHint")}</span>
        <Button
          variant="outline"
          size="xs"
          className="ml-auto shrink-0"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            await loadAccess().catch(() => {});
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={12} /> : <RefreshCw className="size-3" />}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-1 px-3 pb-4">
          {(access?.chats ?? []).map((row) => (
            <div
              key={row.chatId}
              className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2 py-1.5"
            >
              <span
                className={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] leading-none ${LEVEL_STYLE[row.level]}`}
              >
                {row.level}
              </span>
              <span className="min-w-0 flex-1 truncate text-[11px]">
                {row.title !== undefined && row.title.length > 0 ? row.title : `…${row.chatId.slice(-8)}`}
              </span>
              <span className="shrink-0 font-mono text-[10px] text-muted-foreground">…{row.chatId.slice(-6)}</span>
            </div>
          ))}

          {access !== null ? (
            <div className="space-y-0.5 pt-2 text-[10px] text-muted-foreground">
              <div>
                {tr(lang, "approvalsTo")}：
                {access.ownerChat === undefined ? "未记录（先在私聊里给 bot 发一句）" : `…${access.ownerChat.slice(-8)}`}
              </div>
              <div>
                {tr(lang, "envChats")}（{tr(lang, "envChatsHint")}）：
                {access.envChats.length === 0 ? "无" : access.envChats.map((id) => `…${id.slice(-6)}`).join(", ")}
              </div>
            </div>
          ) : null}

          <div className="flex items-center gap-1.5 pt-3 text-[10px] font-medium text-muted-foreground">
            <ShieldCheck className="size-3" />
            {tr(lang, "auditRecent")}
          </div>
          {audit.length === 0 ? (
            <div className="py-2 text-[11px] text-muted-foreground">{tr(lang, "auditEmpty")}</div>
          ) : (
            audit
              .slice()
              .reverse()
              .map((event, index) => (
                <div key={`${event.at}-${index}`} className="flex items-baseline gap-1.5 py-0.5 text-[10px]">
                  <span className="shrink-0 tabular-nums text-muted-foreground">{when(event.at)}</span>
                  <span className="shrink-0 rounded border border-border/60 px-1 text-muted-foreground">
                    {KIND_LABEL[event.kind]}
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {[event.tool, event.detail].filter((part) => part !== undefined).join(" · ")}
                  </span>
                </div>
              ))
          )}
        </div>
      </ScrollArea>
    </div>
  );
}
