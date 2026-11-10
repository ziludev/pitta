import { ShieldAlert } from "lucide-react";
import { motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { tr } from "@/i18n";
import { easeOutCubic } from "@/lib/motion";
import { useStore } from "@/store";

/**
 * Approvals block the tool call, so they must be visible wherever the owner is —
 * not only in the Feishu card. Shown above the composer, newest last.
 */
export function ApprovalBar() {
  const { lang, approvals, decideApproval } = useStore();
  if (approvals.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 border-t border-amber-500/30 bg-amber-500/5 px-4 py-2">
      {approvals.map((approval) => (
        <motion.div
          key={approval.callId}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: easeOutCubic }}
          className="flex items-start gap-2"
        >
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <div className="text-[11.5px] text-amber-200/90">
              {tr(lang, "needsApproval")} · <span className="font-mono">{approval.tool}</span> — {approval.reason}
            </div>
            <pre className="mt-0.5 max-h-16 overflow-hidden font-mono text-[10.5px] whitespace-pre-wrap text-muted-foreground">
              {approval.summary.slice(0, 240)}
            </pre>
          </div>
          <div className="flex shrink-0 gap-1">
            <Button size="xs" variant="secondary" onClick={() => void decideApproval(approval.callId, true)}>
              {tr(lang, "allow")}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => void decideApproval(approval.callId, false)}>
              {tr(lang, "deny")}
            </Button>
          </div>
        </motion.div>
      ))}
    </div>
  );
}
