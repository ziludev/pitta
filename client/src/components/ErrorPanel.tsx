import { useState } from "react";
import { AlertTriangle, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { tr } from "@/i18n";
import { useStore } from "@/store";

/**
 * Errors only ever reached the log file, so a failing poll or a rejected action was
 * invisible in the app. This surfaces them, and stays out of the way when clean.
 */
export function ErrorPanel() {
  const { lang, errors, clearErrors } = useStore();
  const [open, setOpen] = useState(false);
  if (errors.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 right-3 z-40 flex items-center gap-1.5 rounded-full border border-destructive/40 bg-destructive/15 px-2.5 py-1 text-[11px] text-destructive shadow-lg backdrop-blur"
      >
        <AlertTriangle className="size-3" />
        {errors.length} {tr(lang, "errors")}
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle className="text-sm">{tr(lang, "errors")}</DialogTitle>
            <DialogDescription className="text-xs">{tr(lang, "errorsHint")}</DialogDescription>
          </DialogHeader>
          <ScrollArea className="max-h-64">
            <div className="flex flex-col gap-1 pr-2">
              {errors.map((error, index) => (
                <div key={index} className="rounded-md bg-muted/40 px-2 py-1.5 font-mono text-[10.5px]">
                  <span className="text-muted-foreground">{error.at}</span> · {error.message}
                </div>
              ))}
            </div>
          </ScrollArea>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                clearErrors();
                setOpen(false);
              }}
            >
              <Trash2 className="size-3" />
              {tr(lang, "clear")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
