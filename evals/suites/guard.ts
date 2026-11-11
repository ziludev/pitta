import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { approvalReason } from "../../src/approval.ts";
import type { Result, Suite } from "../types.ts";

/**
 * Guard eval: every case is one tool call and the verdict a human would want.
 *
 * The metric that matters is the escape hatch — a destructive call that runs with
 * nobody asked. A case marked `gap` documents a hole the guard still has: it reports as
 * a warning, so the gate stays green while the hole stays on the list, and `--strict`
 * turns it red. A real escape is a failure, never a warning.
 */

type Case = {
  id: string;
  category: string;
  tool: string;
  args: Record<string, unknown>;
  /** `ask` = a human must approve; `quiet` = may run unattended. */
  expect: "ask" | "quiet";
  /** Risk class the approval must be remembered under, when it matters. */
  key?: string;
  /** `expect` is the known-bad behaviour: warn while it holds, pass once it changes. */
  gap?: boolean;
  note?: string;
};

const FILE = fileURLToPath(new URL("../cases/guard.json", import.meta.url));

async function loadCases(): Promise<Case[]> {
  return JSON.parse(await readFile(FILE, "utf8")) as Case[];
}

function verdict(c: Case): { actual: "ask" | "quiet"; key?: string; reason?: string } {
  const need = approvalReason(c.tool, c.args);
  return need === undefined ? { actual: "quiet" } : { actual: "ask", key: need.key, reason: need.reason };
}

function target(c: Case): string {
  return String(c.args["command"] ?? c.args["path"] ?? JSON.stringify(c.args));
}

export const guardSuite: Suite = {
  name: "guard",
  title: "dangerous tool calls vs. the approval guard",
  async run(): Promise<Result[]> {
    const cases = await loadCases();
    return cases.map((c) => {
      const { actual, key, reason } = verdict(c);
      const matches = actual === c.expect && (c.expect === "quiet" || c.key === undefined || key === c.key);

      if (c.gap === true) {
        return matches
          ? { id: c.id, status: "warn", detail: `KNOWN GAP (${c.category}): ${c.note ?? "no note"} — ${target(c)}` }
          : { id: c.id, status: "pass", detail: `known gap closed, remove gap:true from the case — ${target(c)}` };
      }
      if (matches) return { id: c.id, status: "pass", detail: actual === "ask" ? (reason ?? "asks") : "runs unattended" };
      return {
        id: c.id,
        status: "fail",
        detail:
          actual === "quiet"
            ? `ESCAPE: expected approval (${c.key ?? "any"}), ran unattended — ${target(c)}`
            : `expected ${c.expect}${c.key === undefined ? "" : ` (${c.key})`}, got ${actual}${key === undefined ? "" : ` (${key})`} — ${target(c)}`,
      };
    });
  },
};
