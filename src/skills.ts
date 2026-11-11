import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { defineExtension, defineTool, section } from "@earendil-works/pi-durable";
import { obj, opt, str } from "@earendil-works/pi-schema";
import { config } from "./config.ts";
import { log, logError } from "./log.ts";

/**
 * Agent Skills (SKILL.md folders) as pi-durable sees them.
 *
 * Claude Code and `npx skills add` write plain folders: `<dir>/<name>/SKILL.md` with
 * YAML frontmatter (`name`, `description`) plus optional `references/`, `scripts/`.
 * The harness has no notion of skills, so this extension supplies both halves:
 *
 * - a prompt section with the *names* only (grouped, a couple of KB for ~130 skills),
 * - a `skill` tool that searches descriptions or returns one SKILL.md in full.
 *
 * Progressive disclosure, the same reason Claude Code does it this way: paying 5k tokens
 * of descriptions on every turn is worse than one cheap tool call when a skill is needed.
 */

export type Skill = {
  /** Name from the frontmatter, or the folder name when it has none. */
  name: string;
  /** One-line summary, clipped for the prompt. */
  description: string;
  /** Folder the skill lives in; references/ and scripts/ are relative to it. */
  dir: string;
  /** Absolute path of SKILL.md. */
  file: string;
};

/** Body cap for `skill <name>`: some SKILL.md files are 10k+ words. */
const MAX_BODY = 14_000;
/** Frontmatter descriptions are often several sentences; the tool shows more than the prompt. */
const MAX_DESCRIPTION = 400;
/** Re-scan at most this often, so a freshly installed skill shows up without a restart. */
const SCAN_TTL_MS = 30_000;

type Frontmatter = { fields: Record<string, string>; body: string };

/**
 * Minimal YAML frontmatter reader: top-level `key: value` pairs plus `>` / `|` block
 * scalars. Lists and nested maps are skipped on purpose — only name and description
 * matter here, and a full YAML parser would be a heavy dependency for two fields.
 */
export function parseFrontmatter(text: string): Frontmatter {
  const normalised = text.replace(/\r\n/g, "\n");
  if (!normalised.startsWith("---\n")) return { fields: {}, body: normalised };
  const end = normalised.indexOf("\n---", 4);
  if (end < 0) return { fields: {}, body: normalised };
  const header = normalised.slice(4, end).split("\n");
  const body = normalised.slice(end + 4).replace(/^\n+/, "");

  const fields: Record<string, string> = {};
  let key: string | undefined;
  let block: "folded" | "literal" | undefined;
  let lines: string[] = [];
  const flush = (): void => {
    if (key === undefined) return;
    if (block === "folded") fields[key] = lines.join(" ").trim();
    else if (block === "literal") fields[key] = lines.join("\n").trim();
    lines = [];
    block = undefined;
    key = undefined;
  };

  for (const line of header) {
    const top = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (top !== null) {
      flush();
      const [, name, rawValue] = top;
      if (name === undefined) continue;
      const value = (rawValue ?? "").trim();
      if (value === ">" || value === "|" || value === ">-" || value === "|-") {
        key = name;
        block = value.startsWith(">") ? "folded" : "literal";
      } else if (value === "") {
        // Usually a list or a nested map; nothing here needs it.
        fields[name] = "";
      } else {
        fields[name] = value.replace(/^(["'])(.*)\1$/s, "$2").trim();
      }
      continue;
    }
    if (block !== undefined && /^\s+\S/.test(line)) lines.push(line.trim());
  }
  flush();
  return { fields, body };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** First sentence-ish of the body, for skills whose frontmatter has no description. */
function descriptionFromBody(body: string): string {
  for (const line of body.split("\n")) {
    const text = line.replace(/^#+\s*/, "").trim();
    if (text.length > 0) return text.slice(0, MAX_DESCRIPTION);
  }
  return "";
}

async function loadSkill(root: string, entry: string): Promise<Skill | undefined> {
  const dir = join(root, entry);
  const file = join(dir, "SKILL.md");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  const { fields, body } = parseFrontmatter(text);
  const name = (fields["name"] ?? entry).trim() || entry;
  const description = (fields["description"] ?? "").trim() || descriptionFromBody(body);
  return { name, description: description.replace(/\s+/g, " ").trim(), dir, file };
}

let cached: { at: number; dirs: string[]; skills: Skill[] } | undefined;
/** Folders whose SKILL.md exists as a symlink that does not resolve (cc-switch profiles). */
let skipped: string[] = [];
let skippedLogged = "";

/** Broken links are common here (a skill suite kept elsewhere and switched by profile). Say so once. */
function noteSkipped(dirs: string[]): void {
  const signature = dirs.join("|");
  if (signature === skippedLogged) return;
  skippedLogged = signature;
  if (dirs.length === 0) return;
  log("skills", `跳过 ${dirs.length} 个 SKILL.md 读不到的目录（多为失效软链）: ${dirs.slice(0, 6).join(", ")}${dirs.length > 6 ? " …" : ""}`);
}

let duplicatesLogged: string | undefined;

/**
 * The same skill suite is usually installed in two of the scanned directories, so a
 * duplicate is normal and the list is stable. Logging every pair on every scan wrote ten
 * thousand lines a day; this says it once per distinct set instead.
 */
function noteDuplicates(entries: string[]): void {
  const signature = entries.join("|");
  if (signature === duplicatesLogged) return;
  duplicatesLogged = signature;
  if (entries.length === 0) return;
  log(
    "skills",
    `${entries.length} 个重名 skill（保留先到的）: ${entries.slice(0, 5).join(", ")}${entries.length > 5 ? " …" : ""}`,
  );
}

/** Every skill visible to the agent, project dirs first so they win name clashes. */
export async function listSkills(force = false): Promise<Skill[]> {
  const dirs = config.skills.dirs;
  if (!force && cached !== undefined && cached.at > Date.now() - SCAN_TTL_MS && cached.dirs.join() === dirs.join()) {
    return cached.skills;
  }
  const byName = new Map<string, Skill>();
  const unreadable: string[] = [];
  const duplicates: string[] = [];
  for (const root of dirs) {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      continue;
    }
    // Sorted so the prompt section is byte-stable between turns (prompt caching).
    for (const entry of entries.sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const dir = join(root, entry);
      if (!(await isDir(dir))) continue;
      const skill = await loadSkill(root, entry);
      if (skill === undefined) {
        unreadable.push(dir);
        continue;
      }
      const seen = byName.get(skill.name);
      if (seen === undefined) {
        byName.set(skill.name, skill);
      } else if (seen.file !== skill.file) {
        duplicates.push(`${skill.name}（保留 ${seen.file}）`);
      }
    }
  }
  skipped = unreadable;
  noteSkipped(unreadable);
  noteDuplicates(duplicates);
  const skills = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  cached = { at: Date.now(), dirs, skills };
  return skills;
}

/** `lark-doc` + `lark-mail` -> family `lark`, member `doc`. Keeps the prompt short. */
function groupNames(skills: Skill[]): string[] {
  const families = new Map<string, string[]>();
  const singles: string[] = [];
  const counts = new Map<string, number>();
  for (const skill of skills) {
    const family = skill.name.split("-")[0] ?? skill.name;
    counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  for (const skill of skills) {
    const family = skill.name.split("-")[0] ?? skill.name;
    const members = families.get(family) ?? [];
    if (skill.name.includes("-") && (counts.get(family) ?? 0) >= 4) {
      members.push(skill.name.slice(family.length + 1));
      families.set(family, members);
    } else {
      singles.push(skill.name);
    }
  }
  const lines = [...families.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([family, members]) => `${family}: ${members.sort().join(", ")}`);
  if (singles.length > 0) lines.unshift(singles.sort().join(", "));
  return lines;
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}…` : flat;
}

const skillSection = section("skills", async () => {
  const skills = await listSkills().catch((error: unknown) => {
    logError("skills", "scan failed", error);
    return [] as Skill[];
  });
  if (skills.length === 0) return undefined;
  return [
    `本机装了 ${skills.length} 个 skill（SKILL.md 文件夹）。先用 \`skill\` 工具查：`,
    "- 不确定名字：`skill` 带 query（中英都行），按名字+描述搜索；",
    "- 知道名字：`skill` 带 name，返回全文和目录（scripts/ references/ 就在旁边，用 bash/read 取）。",
    "主管人名、项目名这类任务优先看有没有对应 skill，别自己从零写。",
    "",
    ...groupNames(skills).map((line) => `- ${line}`),
  ].join("\n");
});

function search(skills: Skill[], query: string): Skill[] {
  const terms = query
    .toLowerCase()
    .split(/[\s,，]+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 0);
  if (terms.length === 0) return [];
  return skills
    .map((skill) => {
      const name = skill.name.toLowerCase();
      const description = skill.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 100;
        else if (name.includes(term)) score += 30;
        if (description.includes(term)) score += 8;
      }
      // Short names that match are likelier the intended one than a long substring hit.
      return { skill, score: score > 0 ? score + Math.max(0, 20 - name.length) : 0 };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((hit) => hit.skill);
}

function renderMatches(skills: Skill[]): string {
  return skills
    .map((skill) => `- ${skill.name}: ${clip(skill.description, MAX_DESCRIPTION) || "（无描述）"}`)
    .join("\n");
}

const skillTool = defineTool({
  name: "skill",
  description:
    "读一个 skill 的说明（SKILL.md 全文），或用 query 搜索本机已装的 skill。不传参数则列出全部名字。返回的路径旁边就是该 skill 的 scripts/ 和 references/。",
  parameters: obj({
    name: opt(str({ description: "skill 名，如 lark-doc、code-review" })),
    query: opt(str({ description: "按用途搜索，如 飞书 文档、部署、图片压缩" })),
  }),
  replay: "safe",
  execute: async (args) => {
    const skills = await listSkills(true);
    const name = typeof args.name === "string" && args.name.trim().length > 0 ? args.name.trim() : undefined;
    const query = typeof args.query === "string" && args.query.trim().length > 0 ? args.query.trim() : undefined;

    if (name === undefined && query === undefined) {
      return { output: [{ type: "text" as const, text: `${skills.length} 个 skill：\n${groupNames(skills).join("\n")}` }] };
    }

    if (name === undefined) {
      const hits = search(skills, query ?? "");
      return {
        output: [
          {
            type: "text" as const,
            text:
              hits.length === 0
                ? `没有匹配「${query}」的 skill。全部 ${skills.length} 个：\n${groupNames(skills).join("\n")}`
                : `匹配「${query}」：\n${renderMatches(hits.slice(0, 10))}\n\n用 skill(name) 读全文。`,
          },
        ],
      };
    }

    const lowered = name.toLowerCase().replace(/\//g, "-");
    const found =
      skills.find((skill) => skill.name.toLowerCase() === lowered) ??
      skills.find((skill) => skill.name.toLowerCase().replace(/-skill$/, "") === lowered) ??
      (search(skills, name).length === 1 ? search(skills, name)[0] : undefined);

    if (found === undefined) {
      const hits = search(skills, name);
      const deadDir = skipped.find((dir) => dir.split("/").pop()?.toLowerCase() === lowered);
      const dead = deadDir === undefined ? "" : `\n「${name}」的目录在，但 SKILL.md 读不到（软链失效/已被移除）：${deadDir}`;
      return {
        output: [
          {
            type: "text" as const,
            text:
              hits.length === 0
                ? `没有叫「${name}」的 skill。用 skill(query=…) 搜用途，或 skill() 看全部。${dead}`
                : `没有叫「${name}」的 skill，相近的有：\n${renderMatches(hits.slice(0, 8))}${dead}`,
          },
        ],
      };
    }

    let text: string;
    try {
      text = await readFile(found.file, "utf8");
    } catch (error) {
      logError("skills", `read failed: ${found.file}`, error);
      return {
        output: [{ type: "text" as const, text: `读 ${found.file} 失败：${(error as Error).message}` }],
        isError: true,
      };
    }
    const { body } = parseFrontmatter(text);
    const truncated = body.length > MAX_BODY;
    const content = truncated ? `${body.slice(0, MAX_BODY)}\n\n…（已截断，全文见 ${found.file}）` : body;
    return {
      output: [
        {
          type: "text" as const,
          text: [
            `skill: ${found.name}`,
            found.description.length > 0 ? `用途: ${clip(found.description, MAX_DESCRIPTION)}` : "",
            `目录: ${found.dir}（scripts/ references/ 在这里）`,
            "",
            content,
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
        },
      ],
    };
  },
});

export const skillsExtension = defineExtension({
  name: "skills",
  sections: [skillSection],
  tools: [skillTool],
});
