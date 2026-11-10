import { useEffect, useRef } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/** Find inside the open conversation: highlights matches and steps through them. */
export function ConvSearch() {
  const { lang, current, convQuery, setConvQuery, convMatches, convMatchIndex, stepMatch } = useStore();
  const inputRef = useRef<HTMLInputElement>(null);

  // ⌘F focuses the field; Esc clears it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      } else if (event.key === "Escape" && document.activeElement === inputRef.current) {
        setConvQuery("");
        inputRef.current?.blur();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setConvQuery]);

  if (current === undefined) return null;

  return (
    <div className="flex items-center gap-1">
      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted-foreground" />
        <Input
          ref={inputRef}
          value={convQuery}
          onChange={(event) => setConvQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            stepMatch(event.shiftKey ? -1 : 1);
          }}
          placeholder={tr(lang, "findShort")}
          title={tr(lang, "findInChat")}
          className="h-6 w-56 py-0 pl-7 text-[11px] leading-none"
        />
        {convQuery.length > 0 ? (
          <button
            onClick={() => setConvQuery("")}
            className="absolute top-1/2 right-1.5 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            title="clear"
          >
            <X className="size-3" />
          </button>
        ) : null}
      </div>
      {convQuery.trim().length >= 2 ? (
        <>
          <span className="text-[10px] text-muted-foreground tabular-nums">
            {convMatches.length === 0 ? tr(lang, "noHits") : `${convMatchIndex + 1}/${convMatches.length}`}
          </span>
          <Button variant="ghost" size="icon-xs" disabled={convMatches.length === 0} onClick={() => stepMatch(-1)}>
            <ChevronUp className="size-3" />
          </Button>
          <Button variant="ghost" size="icon-xs" disabled={convMatches.length === 0} onClick={() => stepMatch(1)}>
            <ChevronDown className="size-3" />
          </Button>
        </>
      ) : null}
    </div>
  );
}
