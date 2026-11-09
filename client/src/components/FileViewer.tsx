import { useEffect, useState } from "react";
import { ArrowLeft, FileWarning } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { api } from "@/lib/api";
import { tr } from "@/i18n";
import { useStore } from "@/store";

type FilePayload = { path: string; size: number; lines: number; truncated: boolean; content: string };

/** Read-only view of a workspace file, opened from a diff or the changes list. */
export function FileViewer({ path }: { path: string }) {
  const { lang, closeFile } = useStore();
  const [file, setFile] = useState<FilePayload | undefined>();
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    setFile(undefined);
    setError(undefined);
    api<FilePayload>(`/api/file?path=${encodeURIComponent(path)}`)
      .then(setFile)
      .catch((cause: Error) => setError(cause.message));
  }, [path]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Button variant="ghost" size="icon-xs" onClick={closeFile} title={tr(lang, "back")}>
          <ArrowLeft className="size-3.5" />
        </Button>
        <span className="truncate font-mono text-xs">{path}</span>
        {file !== undefined ? (
          <span className="ml-auto shrink-0 text-[10px] text-muted-foreground tabular-nums">
            {file.lines} lines · {(file.size / 1024).toFixed(1)} KB{file.truncated ? ` · ${tr(lang, "truncated")}` : ""}
          </span>
        ) : null}
      </div>
      <ScrollArea className="min-h-0 flex-1">
        {error !== undefined ? (
          <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground">
            <FileWarning className="size-4" />
            {error}
          </div>
        ) : file === undefined ? (
          <div className="p-4 text-xs text-muted-foreground">…</div>
        ) : (
          <pre className="px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre">
            {file.content.split("\n").map((line, index) => (
              <span key={index} className="flex">
                <span className="mr-3 inline-block w-10 shrink-0 text-right text-muted-foreground/50 select-none tabular-nums">
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1">{line === "" ? " " : line}</span>
              </span>
            ))}
          </pre>
        )}
      </ScrollArea>
    </div>
  );
}
