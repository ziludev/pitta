import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { ModelPicker } from "@/components/ModelPicker";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { tr } from "@/i18n";
import { useStore } from "@/store";

export function Composer() {
  const { lang, current, submit, composerDraft, setComposerDraft } = useStore();
  const [text, setText] = useState("");
  const [images, setImages] = useState<Array<{ data: string; mimeType: string; name: string }>>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // "Edit and resend" pushes the old text here; focus so a fix can be typed at once.
  useEffect(() => {
    if (composerDraft === null) return;
    setText(composerDraft);
    setComposerDraft(null);
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [composerDraft, setComposerDraft]);
  const [steer, setSteer] = useState(false);

  const disabled = current === undefined || (text.trim().length === 0 && images.length === 0);

  /** Screenshots arrive through paste; each becomes an image part of this turn. */
  async function onPaste(event: React.ClipboardEvent): Promise<void> {
    const files = [...event.clipboardData.items]
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (files.length === 0) return;
    event.preventDefault();
    const next = await Promise.all(
      files.slice(0, 3).map(
        async (file) =>
          await new Promise<{ data: string; mimeType: string; name: string }>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const url = String(reader.result ?? "");
              resolve({ data: url.slice(url.indexOf(",") + 1), mimeType: file.type, name: file.name });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );
    setImages((current) => [...current, ...next].slice(0, 3));
  }

  async function send() {
    if (disabled) return;
    const value = text;
    const attachments = images.map(({ data, mimeType }) => ({ data, mimeType }));
    setText("");
    setImages([]);
    await submit(value, steer ? "steer" : "followUp", attachments);
  }

  return (
    <div className="border-t border-border px-4 pt-3 pb-3.5">
      {images.length > 0 ? (
        <div className="flex gap-1.5">
          {images.map((image, index) => (
            <button
              key={index}
              onClick={() => setImages((current) => current.filter((_, at) => at !== index))}
              title={tr(lang, "removeImage")}
              className="group relative size-14 overflow-hidden rounded-md border border-border"
            >
              <img src={`data:${image.mimeType};base64,${image.data}`} alt="" className="size-full object-cover" />
              <span className="absolute inset-0 hidden items-center justify-center bg-black/60 text-[10px] text-white group-hover:flex">
                ×
              </span>
            </button>
          ))}
        </div>
      ) : null}
      <Textarea
        ref={inputRef}
        onPaste={(event) => void onPaste(event)}
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
        </div>
        <Button size="sm" onClick={() => void send()} disabled={disabled}>
          <Send className="size-3.5" />
          {tr(lang, "send")}
        </Button>
      </div>
    </div>
  );
}
