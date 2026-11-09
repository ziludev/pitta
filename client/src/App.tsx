import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SquarePen, Square } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Composer } from "@/components/Composer";
import { Rail } from "@/components/Rail";
import { SidePanel } from "@/components/SidePanel";
import { Transcript } from "@/components/Transcript";
import { tr } from "@/i18n";
import { useStore } from "@/store";

function Handle() {
  return <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/60" />;
}

export function App() {
  const { lang, current, surfaces, init, busy, abort, reset } = useStore();

  useEffect(() => {
    void init();
  }, [init]);

  const surface = surfaces.find((item) => item.conversationId === current);

  return (
    <TooltipProvider delayDuration={300}>
      <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
        <PanelGroup direction="horizontal" autoSaveId="agent-layout">
          <Panel defaultSize={19} minSize={13} maxSize={30}>
            <Rail />
          </Panel>
          <Handle />

          <Panel minSize={35}>
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center justify-between border-b border-border px-4 py-2">
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium">
                    {current === undefined ? tr(lang, "noConversation") : `#${current}`}
                  </div>
                  <div className="truncate text-[10px] text-muted-foreground">{surface?.surfaceId ?? ""}</div>
                </div>
                <div className="flex gap-1">
                  <Button variant="ghost" size="xs" onClick={() => void reset()} title="/new">
                    <SquarePen className="size-3" />
                  </Button>
                  <Button variant="ghost" size="xs" onClick={() => void abort()} disabled={!busy} title="/stop">
                    <Square className="size-3" />
                  </Button>
                </div>
              </div>
              <Transcript />
              <Composer />
            </div>
          </Panel>

          <Handle />
          <Panel defaultSize={23} minSize={16} maxSize={36}>
            <SidePanel />
          </Panel>
        </PanelGroup>
        <Toaster position="bottom-left" />
      </div>
    </TooltipProvider>
  );
}
