import type { ReactNode } from "react";

export type DiffFile = { path: string; lines: string[]; added: number; removed: number };

/** Splits a unified diff into files; undefined when the text is not a diff. */
export function parseDiff(text: string): { preamble: string; files: DiffFile[] } | undefined {
  const lines = text.split("\n");
  const looksLikeDiff =
    lines.some((line) => line.startsWith("diff --git ")) ||
    lines.some((line) => /^@@ -\d+(,\d+)? \+\d+(,\d+)? @@/.test(line));
  if (!looksLikeDiff) return undefined;

  const first = lines.findIndex((line) => line.startsWith("diff --git ") || line.startsWith("--- "));
  const preamble = first > 0 ? lines.slice(0, first).join("\n").trim() : "";
  const body = first > 0 ? lines.slice(first) : lines;

  const files: DiffFile[] = [];
  let current: DiffFile | undefined;
  for (const line of body) {
    if (line.startsWith("diff --git ")) {
      const match = / b\/(.+)$/.exec(line);
      current = { path: match?.[1] ?? line.replace("diff --git ", ""), lines: [], added: 0, removed: 0 };
      files.push(current);
      continue;
    }
    if (current === undefined) {
      current = { path: "diff", lines: [], added: 0, removed: 0 };
      files.push(current);
    }
    if (
      line.startsWith("--- ") ||
      line.startsWith("+++ ") ||
      line.startsWith("index ") ||
      line.startsWith("new file ") ||
      line.startsWith("deleted file ")
    ) {
      if (line.startsWith("+++ ") && current.path === "diff") current.path = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (line.startsWith("+")) current.added += 1;
    else if (line.startsWith("-")) current.removed += 1;
    current.lines.push(line);
  }
  return { preamble, files: files.filter((file) => file.lines.length > 0) };
}

export function diffStats(text: string): { files: number; added: number; removed: number } | undefined {
  const parsed = parseDiff(text);
  if (parsed === undefined) return undefined;
  return {
    files: parsed.files.length,
    added: parsed.files.reduce((sum, file) => sum + file.added, 0),
    removed: parsed.files.reduce((sum, file) => sum + file.removed, 0),
  };
}

const LINE_CLASS: Record<string, string> = {
  add: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  del: "bg-rose-500/15 text-rose-800 dark:text-rose-300",
  hunk: "text-sky-700 dark:text-sky-400",
  ctx: "text-muted-foreground",
};

function lineClass(line: string): string {
  if (line.startsWith("@@")) return LINE_CLASS["hunk"]!;
  if (line.startsWith("+")) return LINE_CLASS["add"]!;
  if (line.startsWith("-")) return LINE_CLASS["del"]!;
  return LINE_CLASS["ctx"]!;
}

/** Files of one diff, each collapsible, no wrapping (an editor scrolls sideways). */
export function DiffView({ text, open = true }: { text: string; open?: boolean }): ReactNode {
  const parsed = parseDiff(text);
  if (parsed === undefined) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {parsed.preamble.length > 0 ? (
        <pre className="overflow-x-auto rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
          {parsed.preamble}
        </pre>
      ) : null}
      {parsed.files.map((file) => (
        <details
          key={file.path}
          open={open}
          className="rounded-lg border border-border bg-card/60 px-2.5 py-1.5"
        >
          <summary className="flex cursor-pointer items-baseline gap-2 text-xs text-muted-foreground">
            <span className="truncate font-mono">{file.path}</span>
            <span className="shrink-0 tabular-nums">
              {file.added > 0 ? `+${file.added}` : ""}
              {file.removed > 0 ? ` −${file.removed}` : ""}
            </span>
          </summary>
          <pre className="mt-1.5 max-h-80 overflow-auto rounded-md bg-background/60 p-2 font-mono text-[11px] leading-[1.5] whitespace-pre">
            {file.lines.slice(0, 800).map((line, index) => (
              <span key={index} className={`block ${lineClass(line)}`}>
                {line.length === 0 ? " " : line}
              </span>
            ))}
          </pre>
        </details>
      ))}
    </div>
  );
}
