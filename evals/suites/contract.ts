import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { Result, Suite } from "../types.ts";

/**
 * Contract eval: the docs describe the code that shipped.
 *
 * Three files drift away from each other without anyone noticing: `config.ts` (what is
 * read), `.env.example` (what is offered), `README.md` (what is promised). A key that
 * exists in one and not the others is either a secret knob nobody can find, or an
 * instruction that no longer does anything.
 */

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Keys our own code never reads: the provider SDK does, so docs must still offer them. */
const EXTERNAL_KEYS = new Set(["DEEPSEEK_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY"]);

/** Key names that only show up in a shell or an error message; nothing to document. */
const INTERNAL_KEYS = new Set(["PI_DURABLE_HOME", "AGENT_SURFACE"]);

const ENV_NAME = /\b((?:FEISHU|AGENT|MAGPIE|PI_DURABLE)_[A-Z0-9_]+)\b/g;

async function read(path: string): Promise<string> {
  return readFile(join(ROOT, path), "utf8");
}

async function sourceFiles(): Promise<string[]> {
  const entries = await readdir(join(ROOT, "src"), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(entry.parentPath, entry.name));
}

function literalKeys(source: string): string[] {
  const found = new Set<string>();
  for (const match of source.matchAll(/["'`]([A-Z][A-Z0-9_]{3,})["'`]/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  for (const match of source.matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
    if (match[1] !== undefined) found.add(match[1]);
  }
  return [...found];
}

function exampleKeys(source: string): Map<string, string> {
  const keys = new Map<string, string>();
  for (const line of source.split("\n")) {
    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
    if (match?.[1] !== undefined) keys.set(match[1], (match[2] ?? "").trim());
  }
  return keys;
}

/** The default `config.ts` declares for a key, when it is a plain `?? "literal"`. */
function declaredDefault(configSource: string, key: string): string | undefined {
  const match = new RegExp(`process\\.env\\.${key}\\s*\\?\\?\\s*["']([^"']*)["']`).exec(configSource);
  return match?.[1];
}

export const contractSuite: Suite = {
  name: "contract",
  title: "config.ts ↔ .env.example ↔ README",
  async run(): Promise<Result[]> {
    const results: Result[] = [];
    const [configSource, exampleSource, readme, feishu] = await Promise.all([
      read("src/config.ts"),
      read(".env.example"),
      read("README.md"),
      read("src/feishu.ts"),
    ]);

    const files = await sourceFiles();
    const allKeys = new Set<string>();
    for (const file of files) {
      for (const key of literalKeys(await readFile(file, "utf8"))) allKeys.add(key);
    }
    const operatorKeys = new Set(literalKeys(configSource).filter((key) => !INTERNAL_KEYS.has(key)));
    const documented = exampleKeys(exampleSource);

    // Every knob the code reads is offered, so it can be found without reading the code.
    for (const key of [...operatorKeys].sort()) {
      results.push(
        documented.has(key)
          ? { id: `env/offered:${key}`, status: "pass", detail: `${relative("", "src/config.ts")} → .env.example` }
          : { id: `env/missing:${key}`, status: "fail", detail: `${key} is read by src/config.ts but absent from .env.example` },
      );
    }

    // Every knob offered is read, so the file never lies about what is configurable.
    for (const [key, value] of [...documented].sort(([a], [b]) => a.localeCompare(b))) {
      if (EXTERNAL_KEYS.has(key) || INTERNAL_KEYS.has(key)) continue;
      results.push(
        allKeys.has(key)
          ? { id: `env/read:${key}`, status: "pass", detail: value === "" ? "documented, no default" : `documented, example ${value}` }
          : { id: `env/dead:${key}`, status: "fail", detail: `${key} is offered in .env.example but no source file reads it` },
      );
    }

    // README names only keys that still exist, so a rename cannot leave stale advice.
    const mentioned = new Set<string>();
    for (const match of readme.matchAll(ENV_NAME)) {
      // `AGENT_HTTP_*` is prose shorthand for a family; a real key never ends with `_`.
      if (match[1] === undefined || match[1].endsWith("_")) continue;
      mentioned.add(match[1]);
    }
    for (const key of [...mentioned].sort()) {
      results.push(
        allKeys.has(key)
          ? { id: `readme/env:${key}`, status: "pass", detail: "README key exists in src/" }
          : { id: `readme/env-gone:${key}`, status: "fail", detail: `README mentions ${key}, no source file reads it` },
      );
    }

    // A documented value that contradicts the coded default sends everyone down the wrong path.
    for (const [key, value] of [...documented].sort(([a], [b]) => a.localeCompare(b))) {
      if (value === "" || key === "AGENT_DB" || key === "AGENT_WORKSPACE") continue; // empty = placeholder
      const declared = declaredDefault(configSource, key);
      if (declared === undefined || declared === value) continue;
      results.push({
        id: `env/default-drift:${key}`,
        status: "warn",
        detail: `.env.example says ${key}=${value}, config.ts defaults to "${declared}"`,
      });
    }

    // Slash commands stay documented only while they are handled somewhere.
    const commands = new Set<string>();
    // A command is `/name` in a code span; `/a/b` is a path, so a trailing slash or word
    // character disqualifies the match.
    for (const match of readme.matchAll(/`(\/[a-z][a-z-]*)(?![a-z/-])/g)) if (match[1] !== undefined) commands.add(match[1].slice(1));
    for (const command of [...commands].sort()) {
      results.push(
        new RegExp(`\\b${command}\\b`).test(feishu)
          ? { id: `readme/cmd:${command}`, status: "pass", detail: `/${command} handled in src/feishu.ts` }
          : { id: `readme/cmd-gone:${command}`, status: "fail", detail: `README documents /${command}, src/feishu.ts does not handle it` },
      );
    }

    return results;
  },
};
