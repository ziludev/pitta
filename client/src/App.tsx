import { useEffect } from "react";
import { useState } from "react";
import { flushSync } from "react-dom";
import { PanelRight } from "lucide-react";
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

  // The right panel is a place you go on purpose: changes, commits, usage. Closed by default so the
  // conversation gets the width, and remembered once someone opens it.
  const [sideOpen, setSideOpen] = useState(() => localStorage.getItem("agent.sidePanel") === "1");
  const toggleSide = (): void => {
    const next = !sideOpen;
    localStorage.setItem("agent.sidePanel", next ? "1" : "0");
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // A panel appearing is a change of layout, not of page: a view transition slides the old and new
    // snapshots instead of snapping the whole window. Without the API (or with reduced motion) it is
    // the plain state change it always was.
    if (typeof document.startViewTransition !== "function" || reduceMotion) {
      setSideOpen(next);
      return;
    }
    const transition = document.startViewTransition(() => {
      flushSync(() => setSideOpen(next));
    });
    // If the callback never lands, the panel must still open: the state change is what matters, the
    // animation is what is written on top of it.
    void transition.finished.catch(() => setSideOpen(next));
  };

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
                  {/* Last on the right: it is the edge the panel opens from. */}
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={toggleSide}
                    title={sideOpen ? "收起右栏" : "展开右栏"}
                    className={sideOpen ? "text-primary" : undefined}
                  >
                    <PanelRight className="size-3" />
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

          {sideOpen ? (
            <>
              <Handle />
              <Panel defaultSize={26} minSize={18} maxSize={34} className="[view-transition-name:side-panel]">
                <SidePanel />
              </Panel>
            </>
          ) : null}
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
