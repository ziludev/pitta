import { useMemo } from "react";

type Kind = "json" | "log" | "table" | "text";

const LOG_LINE = /^(\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2})?.*?\b(ERROR|WARN|WARNING|INFO|DEBUG|TRACE|FATAL)\b/;
const LEVEL_CLASS: Record<string, string> = {
  ERROR: "text-rose-600 dark:text-rose-400",
  FATAL: "text-rose-600 dark:text-rose-400",
  WARN: "text-amber-600 dark:text-amber-400",
  WARNING: "text-amber-600 dark:text-amber-400",
  INFO: "text-sky-600 dark:text-sky-400",
  DEBUG: "text-muted-foreground",
  TRACE: "text-muted-foreground/70",
};

function detect(text: string): Kind {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      // fall through: a truncated or streamed payload is still just text
    }
  }
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length >= 3 && lines.filter((line) => LOG_LINE.test(line)).length >= Math.ceil(lines.length * 0.5)) {
    return "log";
  }
  if (lines.length >= 2) {
    const tabs = lines.filter((line) => line.includes("\t")).length;
    const pipes = lines.filter((line) => line.includes("|")).length;
    if (tabs >= lines.length - 1 || pipes >= lines.length - 1) return "table";
  }
  return "text";
}

function splitCells(line: string): string[] {
  if (line.includes("\t")) return line.split("\t");
  return line.split("|").map((cell) => cell.trim()).filter((cell, index, all) => !(index === 0 || index === all.length - 1) || cell.length > 0);
}

const JSON_TOKEN =
  /"(?:[^"\\]|\\.)*"\s*:|"(?:[^"\\]|\\.)*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\btrue\b|\bfalse\b|\bnull\b/g;

function JsonView({ text }: { text: string }) {
  // One pass over the pretty-printed text; the tokens become React spans, so no
  // markup is ever injected (a second regex pass used to eat the class names).
  const nodes = useMemo(() => {
    const pretty = (() => {
      try {
        return JSON.stringify(JSON.parse(text.trim()), null, 2);
      } catch {
        return text;
      }
    })();
    const out: React.ReactNode[] = [];
    let last = 0;
    let key = 0;
    for (const match of pretty.matchAll(JSON_TOKEN)) {
      const index = match.index ?? 0;
      if (index > last) out.push(pretty.slice(last, index));
      const token = match[0];
      const className = token.endsWith(":")
        ? "text-sky-600 dark:text-sky-400"
        : token.startsWith('"')
          ? "text-emerald-600 dark:text-emerald-400"
          : /^(true|false)$/.test(token)
            ? "text-fuchsia-600 dark:text-fuchsia-400"
            : token === "null"
              ? "text-muted-foreground"
              : "text-amber-600 dark:text-amber-400";
      out.push(
        <span key={key++} className={className}>
          {token}
        </span>,
      );
      last = index + token.length;
    }
    if (last < pretty.length) out.push(pretty.slice(last));
    return out;
  }, [text]);

  return (
    <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre">{nodes}</pre>
  );
}

function LogView({ text }: { text: string }) {
  return (
    <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
      {text.split("\n").map((line, index) => {
        const match = LOG_LINE.exec(line);
        const level = match?.[2]?.toUpperCase();
        return (
          <span key={index} className={`block ${level === undefined ? "" : LEVEL_CLASS[level] ?? ""}`}>
            {line.length === 0 ? " " : line}
          </span>
        );
      })}
    </pre>
  );
}

function TableView({ text }: { text: string }) {
  const rows = text
    .split("\n")
    .filter((line) => line.trim().length > 0 && !/^[-+|\s]+$/.test(line))
    .map(splitCells);
  const [head, ...body] = rows;
  if (head === undefined) return null;
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse font-mono text-[11px]">
        <thead>
          <tr>
            {head.map((cell, index) => (
              <th key={index} className="border-b border-border px-2 py-1 text-left font-medium text-muted-foreground">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-muted/20">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="px-2 py-0.5 whitespace-nowrap">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Renders tool output by shape: JSON, logs, tables, everything else verbatim. */
export function ToolOutput({ text }: { text: string }) {
  const kind = useMemo(() => detect(text), [text]);
  const body = text.length > 20_000 ? text.slice(0, 20_000) : text;
  if (kind === "json") return <JsonView text={JSON.stringify(JSON.parse(body.trim()), null, 2)} />;
  if (kind === "log") return <LogView text={body} />;
  if (kind === "table") return <TableView text={body} />;
  return (
    <pre className="max-h-80 overflow-auto font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted-foreground">
      {body.length > 4000 ? `${body.slice(0, 4000)}\n…` : body}
    </pre>
  );
}
