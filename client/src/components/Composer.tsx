import { useState } from "react";
import { Send, Square, SquarePen } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tr } from "@/i18n";
import { useStore } from "@/store";

export function Composer() {
  const { lang, current, busy, submit, abort, reset } = useStore();
  const [text, setText] = useState("");
  const [steer, setSteer] = useState(false);

  const disabled = current === undefined || text.trim().length === 0;

  async function send() {
    if (disabled) return;
    const value = text;
    setText("");
    await submit(value, steer ? "steer" : "followUp");
  }

  return (
    <div className="border-t border-border px-4 pt-3 pb-3.5">
      <Textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            void send();
          }
        }}
        rows={3}
        placeholder={tr(lang, "placeholder")}
        className="resize-none text-[13px]"
      />
      <div className="mt-2 flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <ModelPicker />
          <span className="h-3.5 w-px shrink-0 bg-border" />
          <label className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
            <input
              type="checkbox"
              checked={steer}
              onChange={(event) => setSteer(event.target.checked)}
              className="size-3 accent-primary"
            />
            {tr(lang, "steer")}
          </label>
          <Button variant="ghost" size="xs" onClick={() => void reset()} title="/new">
            <SquarePen className="size-3" />
            /new
          </Button>
          <Button variant="ghost" size="xs" onClick={() => void abort()} disabled={!busy} title="/stop">
            <Square className="size-3" />
            /stop
          </Button>
        </div>
        <Button size="sm" onClick={() => void send()} disabled={disabled}>
          <Send className="size-3.5" />
          {tr(lang, "send")}
        </Button>
      </div>
    </div>
  );
}
