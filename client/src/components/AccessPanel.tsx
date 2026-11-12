import { useEffect, useState } from "react";
import { RefreshCw, ShieldCheck, ShieldQuestion } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Spinner } from "@/components/ui/spinner";
import { tr } from "@/i18n";
import type { AccessLevel, AccessRow, AuditEvent } from "@/lib/api";
import { useStore } from "@/store";

/**
 * Who may use which chat, and what was decided recently. The Feishu side decides this from
 * `app.chat-access`; this page is the same data as `durable access`, without a terminal.
 */

const LEVEL_ORDER: AccessLevel[] = ["group", "owner", "closed"];

const LEVEL_DOT: Record<AccessLevel, string> = {
  group: "bg-amber-500",
  owner: "bg-emerald-500",
  closed: "bg-muted-foreground/50",
};

const LEVEL_CHIP: Record<AccessLevel, string> = {
  group: "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400",
  owner: "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  closed: "border-border bg-muted/50 text-muted-foreground",
};

const LEVEL_LABEL: Record<AccessLevel, string> = {
  group: "所有人可用",
  owner: "仅主人",
  closed: "已关闭",
};

const KIND_CHIP: Record<AuditEvent["kind"], string> = {
  access: "border-border bg-muted/50 text-muted-foreground",
  deny: "border-rose-500/35 bg-rose-500/10 text-rose-600 dark:text-rose-400",
  approve: "border-emerald-500/35 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  query: "border-sky-500/35 bg-sky-500/10 text-sky-600 dark:text-sky-400",
  report: "border-amber-500/35 bg-amber-500/10 text-amber-600 dark:text-amber-400",
};

const KIND_LABEL: Record<AuditEvent["kind"], string> = {
  access: "级别",
  deny: "拦截",
  approve: "审批",
  query: "查询",
  report: "来访",
};

/** The shortest thing that still tells two chats apart. */
function chatLabel(row: AccessRow): string {
  return row.title !== undefined && row.title.length > 0 ? row.title : `…${row.chatId.slice(-8)}`;
}

function clockOf(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { hour12: false, hour: "2-digit", minute: "2-digit" });
}

function Stat({ level, count }: { level: AccessLevel; count: number }) {
  return (
    <div className={`flex min-w-0 items-center gap-1 rounded-full border px-2 py-[3px] ${LEVEL_CHIP[level]}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${LEVEL_DOT[level]}`} />
      <span className="text-[11px] leading-none tabular-nums">{count}</span>
      <span className="truncate text-[10px] leading-none opacity-75">{LEVEL_LABEL[level]}</span>
    </div>
  );
}

export function AccessPanel() {
  const { lang, access, audit, loadAccess } = useStore();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void loadAccess().catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = access?.chats ?? [];
  const grouped = LEVEL_ORDER.map((level) => ({ level, rows: rows.filter((row) => row.level === level) })).filter(
    (group) => group.rows.length > 0,
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-start gap-2 px-3 pt-2.5">
        <div className="flex min-w-0 flex-1 gap-1.5">
          <Stat level="group" count={rows.filter((row) => row.level === "group").length} />
          <Stat level="owner" count={rows.filter((row) => row.level === "owner").length} />
        </div>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          title={tr(lang, "accessHint")}
          onClick={async () => {
            setBusy(true);
            await loadAccess().catch(() => {});
            setBusy(false);
          }}
        >
          {busy ? <Spinner size={12} /> : <RefreshCw className="size-3.5" />}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-3 px-3 pb-4 pt-3">
          {access === null ? (
            <div className="py-6 text-center text-[11px] text-muted-foreground">读取中…</div>
          ) : rows.length === 0 ? (
            <div className="flex flex-col items-center gap-1.5 py-8 text-center text-muted-foreground">
              <ShieldQuestion className="size-5 opacity-60" />
              <span className="text-[11px]">还没有任何会话级别</span>
              <span className="px-4 text-[10px] opacity-70">有人找 bot 时会给你发一张开放卡</span>
            </div>
          ) : (
            grouped.map((group) => (
              <div key={group.level} className="space-y-1">
                <div className="flex items-baseline gap-1.5 px-0.5">
                  <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                    {LEVEL_LABEL[group.level]}
                  </span>
                  <span className="text-[10px] tabular-nums text-muted-foreground/70">{group.rows.length}</span>
                </div>
                {group.rows.map((row) => (
                  <div
                    key={row.chatId}
                    className="group flex items-center gap-2 rounded-md border border-border/50 bg-card/40 px-2 py-1.5"
                  >
                    <span className={`size-1.5 shrink-0 rounded-full ${LEVEL_DOT[row.level]}`} />
                    <span className="min-w-0 flex-1 truncate text-[11px]" title={row.chatId}>
                      {chatLabel(row)}
                      {row.chatOwner === undefined ? null : (
                        <span className="ml-1 text-[9.5px] text-muted-foreground/60">
                          群主 …{row.chatOwner.slice(-6)}
                          {row.members === undefined ? "" : ` · ${row.members} 人`}
                        </span>
                      )}
                    </span>
                    {row.conversationId === undefined ? null : (
                      <span className="shrink-0 font-mono text-[10px] text-muted-foreground/60">
                        #{row.conversationId}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            ))
          )}

          {access !== null ? (
            <div className="space-y-1 rounded-lg border border-border/50 bg-muted/20 px-2.5 py-2 text-[10px] text-muted-foreground">
              <div className="flex gap-1.5">
                <span className="shrink-0 opacity-70">审批卡发往</span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {access.ownerChat === undefined ? "未记录（先在私聊里给 bot 发一句）" : `…${access.ownerChat.slice(-8)}`}
                </span>
              </div>
              <div className="flex gap-1.5">
                <span className="shrink-0 opacity-70">`.env` 里的 chat</span>
                <span className="min-w-0 flex-1 truncate font-mono">
                  {access.envChats.length === 0 ? "无" : access.envChats.map((id) => `…${id.slice(-6)}`).join(" · ")}
                </span>
              </div>
              <div className="opacity-60">{tr(lang, "envChatsHint")}</div>
            </div>
          ) : null}

          <div className="space-y-1">
            <div className="flex items-baseline gap-1.5 px-0.5">
              <ShieldCheck className="size-3 self-center text-muted-foreground" />
              <span className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {tr(lang, "auditRecent")}
              </span>
            </div>
            {audit.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 px-3 py-5 text-center text-[10px] text-muted-foreground">
                {tr(lang, "auditEmpty")}
              </div>
            ) : (
              audit
                .slice()
                .reverse()
                .map((event, index) => (
                  <div
                    key={`${event.at}-${index}`}
                    className="flex items-center gap-1.5 rounded-md px-0.5 py-1 text-[10px] hover:bg-muted/30"
                  >
                    <span className="shrink-0 tabular-nums text-muted-foreground/70">{clockOf(event.at)}</span>
                    <span className={`shrink-0 rounded border px-1 leading-4 ${KIND_CHIP[event.kind]}`}>
                      {KIND_LABEL[event.kind]}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground" title={event.detail}>
                      {[event.tool, event.detail].filter((part) => part !== undefined && part.length > 0).join(" · ")}
                    </span>
                  </div>
                ))
            )}
          </div>
        </div>
      </ScrollArea>
    </div>
  );
}
