import { motion } from "motion/react";
import type { ReactNode } from "react";
import { easeOutCubic, emptyState } from "@/lib/motion";

/**
 * Motion Prompt #072: the empty state fades in while rising 8 px over 350 ms,
 * led by a line drawing of a tray.
 */
export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: emptyState.rise }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: emptyState.duration, ease: easeOutCubic }}
      className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center"
    >
      <svg width="72" height="54" viewBox="0 0 72 54" fill="none" aria-hidden className="text-sky-500/70">
        <path d="M8 30h14l5 7h18l5-7h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M8 30 18 10h36l10 20v12a4 4 0 0 1-4 4H12a4 4 0 0 1-4-4V30Z" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" />
      </svg>
      <div className="text-[12px] text-muted-foreground">{title}</div>
      {hint === undefined ? null : <div className="text-[10.5px] text-muted-foreground/70">{hint}</div>}
      {action}
    </motion.div>
  );
}
