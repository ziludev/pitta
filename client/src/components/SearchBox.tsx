import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { tr } from "@/i18n";
import { useStore } from "@/store";

type Hit = { conversationId: number; entryId: number; kind: string; snippet: string };

/** Filters the session list by name, and searches transcript text on submit. */
export function SearchBox() {
  const { lang, setFilter, select, setFocusEntry } = useStore();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<Hit[] | undefined>();
  const [pending, setPending] = useState(false);

  async function search() {
    const value = query.trim();
    setFilter(value);
    if (value.length < 2) {
      setHits(undefined);
      return;
    }
    setPending(true);
    try {
      const result = await api<{ hits: Hit[] }>(`/api/search?q=${encodeURIComponent(value)}`);
      setHits(result.hits);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="px-2.5 pb-1">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void search();
        }}
        className="relative"
      >
        <Search className="pointer-events-none absolute top-1.5 left-2 size-3 text-muted-foreground" />
        <Input
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setFilter(event.target.value);
            if (event.target.value.trim().length < 2) setHits(undefined);
          }}
          placeholder={tr(lang, "search")}
          className="h-7 pl-7 text-[11px]"
        />
      </form>
      {pending ? <div className="pt-1 text-[10px] text-muted-foreground">…</div> : null}
      {hits !== undefined && hits.length > 0 ? (
        <div className="mt-1 max-h-40 overflow-y-auto rounded-md border border-border">
          {hits.map((hit) => (
            <button
              key={`${hit.conversationId}-${hit.entryId}`}
              onClick={async () => {
                await select(hit.conversationId);
                setFocusEntry(hit.entryId);
              }}
              className="block w-full border-b border-border/60 px-2 py-1 text-left last:border-b-0 hover:bg-accent/10"
            >
              <div className="text-[10px] text-muted-foreground">
                #{hit.conversationId} · {hit.kind.replace("pi.", "")}
              </div>
              <div className="line-clamp-2 text-[11px]">{hit.snippet}</div>
            </button>
          ))}
        </div>
      ) : null}
      {hits !== undefined && hits.length === 0 && !pending ? (
        <div className="pt-1 text-[10px] text-muted-foreground">{tr(lang, "noHits")}</div>
      ) : null}
    </div>
  );
}
