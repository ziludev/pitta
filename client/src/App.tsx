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
import { TaskDialog } from "@/components/TaskDialog";
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
          <Panel defaultSize={21} minSize={16} maxSize={30}>
            <Rail />
          </Panel>
          <Handle />

          <Panel minSize={35}>
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium leading-tight">
                    {surface !== undefined && surface.title !== undefined && surface.title.length > 0
                      ? surface.title
                      : current === undefined
                        ? tr(lang, "noConversation")
                        : `${tr(lang, "newChat")} #${current}`}
                  </div>
                  <div className="flex min-w-0 items-baseline gap-1.5 text-[10px] text-muted-foreground/60">
                    <span className="truncate font-mono">{surface?.surfaceId ?? ""}</span>
                    {current === undefined ? null : <span className="shrink-0 font-mono">#{current}</span>}
                  </div>
                </div>
                <ConvSearch />
                <div className="flex shrink-0 items-center gap-0.5">
                  <Button variant="ghost" size="icon-xs" onClick={() => void reset()} title="/new">
                    <SquarePen className="size-3" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={() => void abort()}
                    disabled={!busy}
                    title="/stop"
                    className={busy ? "text-rose-500" : undefined}
                  >
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
          <Panel defaultSize={26} minSize={18} maxSize={34}>
            <SidePanel />
          </Panel>
        </PanelGroup>
        {/* #056: the toast lives 3.2s; its time bar drains over the spec's 1.8s. */}
        <ErrorPanel />
        <TaskDialog />
        <Toaster position="bottom-left" duration={3200} visibleToasts={3} gap={8} />
      </div>
      </TooltipProvider>
      </ThemeProvider>
    </MotionConfig>
  );
}
