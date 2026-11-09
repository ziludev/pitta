import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { cn } from "cn";
import { ChevronRight } from "lucide-react";
import { tr } from "@/i18n";
import type { Entry } from "@/lib/api";
import { DiffView, diffStats } from "@/lib/diff";
import { Markdown } from "@/lib/markdown";
import { useStore } from "@/store";

type Part = Record<string, unknown>;

function partsOf(model: unknown): Part[] {
  const list = Array.isArray(model) ? model : [];
  const parts: Part[] = [];
  for (const message of list as Part[]) {
    const content = message["content"];
    if (typeof content === "string") parts.push({ type: "text", text: content });
    else if (Array.isArray(content)) {
      for (const part of content as Part[]) {
        parts.push({ ...part, role: message["role"], toolName: message["toolName"] });
      }
    }
  }
  return parts;
}

const textOf = (parts: Part[]): string =>
  parts
    .filter((part) => part["type"] === "text")
    .map((part) => String(part["text"] ?? ""))
    .join("");

function Collapsible({ title, children }: { title: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-lg border border-border bg-card/50">
      <button
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-[11px] text-muted-foreground hover:text-foreground"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {title}
      </button>
      {open ? <div className="border-t border-border px-2.5 py-2">{children}</div> : null}
    </div>
  );
}

function EntryView({ entry }: { entry: Entry }) {
  const lang = useStore((state) => state.lang);
  const parts = partsOf(entry.model);
  const text = textOf(parts);
  const thinking = parts
    .filter((part) => part["type"] === "thinking")
    .map((part) => String(part["thinking"] ?? ""))
    .join("\n");

  if (entry.kind === "pi.user") {
    const images = parts.filter((part) => part["type"] === "image").length;
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex justify-end">
        <div className="max-w-[86%] rounded-xl rounded-br-sm border border-primary/25 bg-primary/12 px-3 py-2 text-[13px] leading-relaxed">
          <Markdown text={text} />
          {images > 0 ? (
            <div className="mt-1 text-[10px] text-muted-foreground">
              [{images} {tr(lang, "images")}]
            </div>
          ) : null}
        </div>
      </motion.div>
    );
  }

  if (entry.kind === "pi.assistant") {
    const calls = parts.filter((part) => part["type"] === "toolCall");
    return (
      <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="flex max-w-[92%] flex-col gap-1.5">
        {calls.length > 0 ? (
          <div className="flex flex-wrap gap-1">
            {calls.map((call, index) => (
              <span
                key={index}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 font-mono text-[10px] text-muted-foreground"
              >
                {String(call["name"] ?? "")}
              </span>
            ))}
          </div>
        ) : null}
        {text.length > 0 ? (
          <div className="rounded-xl rounded-bl-sm border border-border bg-card/70 px-3 py-2 text-[13px] leading-relaxed">
            <Markdown text={text} />
          </div>
        ) : null}
        {thinking.length > 0 ? (
          <Collapsible title={tr(lang, "thinking")}>
            <pre className="max-h-64 overflow-auto font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
              {thinking}
            </pre>
          </Collapsible>
        ) : null}
      </motion.div>
    );
  }

  if (entry.kind === "pi.tool-result") {
    const name = String(parts[0]?.["toolName"] ?? "tool");
    const stats = diffStats(text);
    if (stats !== undefined) {
      return (
        <div className="flex max-w-[92%] flex-col gap-1">
          <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-mono">{name}</span>
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px]">
              diff · {stats.files} {tr(lang, "diffSummary")} · +{stats.added} −{stats.removed}
            </span>
          </div>
          <DiffView text={text} />
        </div>
      );
    }
    return (
      <div className="max-w-[92%]">
        <Collapsible title={`${name} · ${tr(lang, "output")}`}>
          <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
            {text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text}
          </pre>
        </Collapsible>
      </div>
    );
  }

  if (entry.kind === "app.feature-report") {
    const payload = (entry.data ?? {}) as { text?: string };
    return (
      <div className="max-w-[92%] rounded-lg border border-border bg-card/60 p-2.5">
        <div className="mb-1 text-[11px] text-muted-foreground">🧩 {tr(lang, "featureReport")}</div>
        <div className="text-[13px] leading-relaxed">
          <Markdown text={payload.text ?? ""} />
        </div>
      </div>
    );
  }

  if (entry.kind === "pi.system") return null;
  return <div className="text-[11px] text-muted-foreground">{entry.kind}</div>;
}

function LiveBlock() {
  const { lang, live } = useStore();
  if (live === undefined) return null;
  const tools = Array.isArray(live.tools) ? live.tools : [];
  const running = tools.find((slot) => slot["status"] === "running");
  const partial = textOf(partsOf(live.generation?.message));
  const tail = running
    ? (String(running["output"] ?? "")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .pop() ?? "")
    : "";
  if (running === undefined && partial.length === 0) return null;
  return (
    <motion.div initial={{ opacity: 0.6 }} animate={{ opacity: 1 }} className="flex max-w-[92%] flex-col gap-1.5">
      {running !== undefined ? (
        <span className="w-fit animate-pulse rounded-full border border-primary/50 px-2 py-0.5 font-mono text-[10px] text-primary">
          {String(running["name"] ?? "")}
        </span>
      ) : null}
      {partial.length > 0 ? (
        <div className="rounded-xl rounded-bl-sm border border-dashed border-border bg-card/50 px-3 py-2 text-[13px] leading-relaxed">
          <Markdown text={partial} />
        </div>
      ) : null}
      {tail.length > 0 ? (
        <div className="truncate text-[10px] text-muted-foreground">{tail.slice(0, 160)}</div>
      ) : null}
    </motion.div>
  );
}

export function Transcript() {
  const { entries, focusEntry } = useStore();
  const boxRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const focused = useRef(false);

  const content = useMemo(() => entries, [entries]);

  useEffect(() => {
    const box = boxRef.current;
    if (box !== null && stick) box.scrollTop = box.scrollHeight;
  }, [content, stick]);

  // ?entry=<id> deep links: jump once and stop following the tail.
  useEffect(() => {
    if (focused.current || focusEntry === undefined) return;
    const node = boxRef.current?.querySelector<HTMLElement>(`[data-entry="${focusEntry}"]`);
    if (node === undefined || node === null) return;
    focused.current = true;
    setStick(false);
    node.scrollIntoView({ block: "start" });
  }, [content, focusEntry]);

  return (
    <div
      ref={boxRef}
      onScroll={(event) => {
        const box = event.currentTarget;
        setStick(box.scrollHeight - box.scrollTop - box.clientHeight < 80);
      }}
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4"
    >
      <div className="flex flex-col gap-3">
        {content.map((entry) => (
          <div key={entry.id} data-entry={entry.id}>
            <EntryView entry={entry} />
          </div>
        ))}
        <LiveBlock />
      </div>
    </div>
  );
}
