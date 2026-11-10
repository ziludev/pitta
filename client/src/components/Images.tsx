import { useState } from "react";
import { X } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";

export type ImagePart = { data: string; mimeType: string };

const src = (image: ImagePart): string => `data:${image.mimeType};base64,${image.data}`;

/**
 * Thumbnails that open full size. Conversation images are stored inline in the
 * transcript, so a preview is a dialog rather than a file open.
 */
export function Images({
  images,
  size = "thread",
  onRemove,
}: {
  images: ImagePart[];
  /** thread = inside a bubble (smaller), compose = before sending. */
  size?: "thread" | "compose";
  onRemove?: (index: number) => void;
}) {
  const [open, setOpen] = useState<number | undefined>();
  if (images.length === 0) return null;

  const box = size === "compose" ? "size-14" : "h-24 w-auto max-w-[220px]";

  return (
    <>
      <div className="flex flex-wrap gap-1.5">
        {images.map((image, index) => (
          <div key={index} className="group relative">
            <button
              onClick={() => setOpen(index)}
              className={`overflow-hidden rounded-md border border-border/70 ${box}`}
              title="preview"
            >
              <img src={src(image)} alt="" className={`${box} object-cover`} draggable={false} />
            </button>
            {onRemove === undefined ? null : (
              <button
                onClick={(event) => {
                  event.stopPropagation();
                  onRemove(index);
                }}
                className="absolute -top-1 -right-1 hidden size-4 items-center justify-center rounded-full bg-background/90 text-muted-foreground shadow group-hover:flex hover:text-foreground"
                title="remove"
              >
                <X className="size-2.5" />
              </button>
            )}
          </div>
        ))}
      </div>

      <Dialog open={open !== undefined} onOpenChange={(next) => setOpen(next ? open : undefined)}>
        <DialogContent className="max-w-[90vw] border-none bg-transparent p-0 shadow-none">
          <DialogTitle className="sr-only">image</DialogTitle>
          {open === undefined ? null : (
            <img
              src={src(images[open]!)}
              alt=""
              className="max-h-[82vh] w-auto rounded-lg border border-border shadow-2xl"
              draggable={false}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
