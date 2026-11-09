/**
 * One-off migration: pull Hermes' memory files into this agent's global memory.
 *
 *   node scripts/import-hermes-memory.ts            # dry run, prints what would import
 *   node scripts/import-hermes-memory.ts --apply    # write into app.global-memory
 *
 * Hermes stores memory as markdown blocks separated by a lone "§" line.
 * Template placeholders from its own prompts are skipped.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { context, openRuntime } from "../src/harness.ts";
import { GlobalMemory, type Note } from "../src/memory.ts";

const run = promisify(execFile);
const SOURCES = [
  { file: join(homedir(), ".hermes", "memories", "USER.md"), label: "hermes/USER" },
  { file: join(homedir(), ".hermes", "memories", "MEMORY.md"), label: "hermes/MEMORY" },
];

const PLACEHOLDERS = [
  /^_Learn about the person/i,
  /^Context:\s*_\(/i,
  /^Context:\s*---\s*$/i,
  /^Context:\s*The more you know/i,
  /_\(optional\)_/i,
];

function clean(block: string): string {
  const text = block.replace(/\s+/g, " ").trim();
  // Keep the label ("Timezone: Asia/Shanghai") instead of a bare value, but drop
  // markdown bold and blocks that are only a heading.
  const unbold = text.replace(/\*\*(.+?):\*\*/g, "$1:");
  if (/^[\w\u4e00-\u9fa5 ()/-]+:\s*$/.test(unbold)) return "";
  if (/^(Notes|Context):\s*$/i.test(unbold)) return "";
  return unbold;
}

function parse(file: string, content: string, at: string): Note[] {
  const notes: Note[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(/^\s*§\s*$/m)) {
    const block = raw.trim();
    if (block.length === 0) continue;
    if (PLACEHOLDERS.some((pattern) => pattern.test(block))) continue;
    const text = clean(block);
    if (text.length < 8) continue;
    if (seen.has(text)) continue;
    // "Name: Alex" and "What to call them: Alex" are the same fact.
    const value = (text.split(":").pop() ?? "").trim().toLowerCase();
    if (value.length > 0 && value.length < 60 && seen.has(`value:${value}`)) continue;
    seen.add(text);
    if (value.length > 0 && value.length < 60) seen.add(`value:${value}`);
    notes.push({ at, text: text.slice(0, 1500) });
  }
  return notes;
}

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");

  // One writer per storage: refuse to run while the launchd agent holds it.
  const running = await run("pgrep", ["-f", "src/main.ts"]).then(
    () => true,
    () => false,
  );
  if (running) {
    console.error("agent is running (src/main.ts); stop it first: ./scripts/agentctl stop");
    process.exit(1);
  }

  const incoming: Array<Note & { source: string }> = [];
  for (const source of SOURCES) {
    if (!existsSync(source.file)) {
      console.warn(`skip ${source.label}: not found`);
      continue;
    }
    const info = await stat(source.file);
    const at = new Date(info.mtimeMs).toISOString();
    const notes = parse(source.file, await readFile(source.file, "utf8"), at);
    console.log(`${source.label}: ${notes.length} blocks`);
    for (const note of notes) incoming.push({ ...note, source: source.label });
  }

  const runtime = await openRuntime();
  try {
    const existing = (await runtime.harness.snapshot(GlobalMemory, context))?.notes ?? [];
    const known = new Set(existing.map((note) => note.text));
    const fresh = incoming.filter((note) => !known.has(note.text));

    console.log(`\nexisting: ${existing.length}, importable: ${fresh.length}`);
    for (const [index, note] of fresh.entries()) {
      console.log(`\n[${index + 1}] ${note.source} ${note.at.slice(0, 10)}\n    ${note.text.slice(0, 300)}`);
    }
    if (fresh.length === 0) return;

    if (!apply) {
      console.log("\ndry run: re-run with --apply to write these into app.global-memory");
      return;
    }

    await runtime.harness.commit(async (tx) => {
      const doc = await tx.doc(GlobalMemory);
      for (const note of fresh) doc.notes.push({ at: note.at, text: note.text });
    }, context);
    console.log(`\nimported ${fresh.length} notes into app.global-memory`);
  } finally {
    await runtime.close();
  }
}

await main();
