import { useEffect } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { SquarePen, Square } from "lucide-react";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { ApprovalBar } from "@/components/ApprovalBar";
import { ConvSearch } from "@/components/ConvSearch";
import { ErrorPanel } from "@/components/ErrorPanel";
import { Composer } from "@/components/Composer";
import { Rail } from "@/components/Rail";
import { SidePanel } from "@/components/SidePanel";
import { Transcript } from "@/components/Transcript";
import { FileViewer } from "@/components/FileViewer";
import { tr } from "@/i18n";
import { MotionConfig } from "motion/react";
import { ThemeProvider } from "next-themes";
import { useStore } from "@/store";

function Handle() {
  return <PanelResizeHandle className="w-px bg-border transition-colors hover:bg-primary/60" />;
}

export function App() {
  const { lang, current, surfaces, init, busy, abort, reset, view } = useStore();
  // ?theme=dark|light forces a theme (screenshots, demos); otherwise follow the system.
  const forced = new URLSearchParams(location.search).get("theme");
  const forcedTheme = forced === "dark" || forced === "light" ? forced : undefined;

  useEffect(() => {
    void init();
  }, [init]);

  const surface = surfaces.find((item) => item.conversationId === current);

  return (
    <MotionConfig reducedMotion="user">
      <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      forcedTheme={forcedTheme}
      disableTransitionOnChange
    >
    <TooltipProvider delayDuration={300}>
      <div className="h-screen w-screen overflow-hidden bg-background text-foreground">
        <PanelGroup direction="horizontal" autoSaveId="agent-layout">
          <Panel defaultSize={22} minSize={15} maxSize={32}>
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
                <div className="flex items-center gap-2">
                  <ConvSearch />
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
              {view.kind === "file" ? (
                <FileViewer path={view.path} />
              ) : (
                <>
                  <Transcript />
                  <ApprovalBar />
                  <Composer />
                </>
              )}
            </div>
          </Panel>

          <Handle />
          <Panel defaultSize={24} minSize={17} maxSize={36}>
            <SidePanel />
          </Panel>
        </PanelGroup>
        {/* #056: the toast lives 3.2s; its time bar drains over the spec's 1.8s. */}
        <ErrorPanel />
        <Toaster position="bottom-left" duration={3200} visibleToasts={3} gap={8} />
      </div>
      </TooltipProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
