import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, basename, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineDoc, type Harness } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { log } from "./log.ts";

const run = promisify(execFile);

export type Project = {
  id: string;
  name: string;
  /** Absolute path of the git repo (the main checkout). */
  path: string;
  /** The built-in sandbox cannot be removed. */
  builtin?: boolean;
  createdAt: number;
};

/**
 * A project is a git repository the agent may work in; each chat inside it gets its
 * own worktree and branch. Same model ThinkRail uses (project → workspace → chats),
 * minus the IDE around it.
 */
export const ProjectsDoc = defineDoc<{ projects: Project[] }>({
  kind: "app.projects",
  version: 1,
  scope: "session",
  initial: () => ({ projects: [] }),
  checkpointWhen: () => false,
});

/** conversationId -> projectId, so a chat remembers which repo it belongs to. */
export const ConversationProjectDoc = defineDoc<{
  byConversation: Record<string, string>;
  /** Branch this chat compares against and merges into; defaults to the project's HEAD. */
  baseByConversation?: Record<string, string>;
  /** Branch the worktree was created from; a different base means extra commits show up. */
  originByConversation?: Record<string, string>;
}>({
  kind: "app.conversation-project",
  version: 1,
  scope: "session",
  initial: () => ({ byConversation: {}, baseByConversation: {}, originByConversation: {} }),
  checkpointWhen: () => false,
});

export async function listProjects(harness: Harness, context: Context): Promise<Project[]> {
  return (await harness.snapshot(ProjectsDoc, context))?.projects ?? [];
}

export async function projectOf(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<string | undefined> {
  const doc = await harness.snapshot(ConversationProjectDoc, context);
  return doc?.byConversation[String(conversationId)];
}

export async function baseOf(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<string | undefined> {
  const doc = await harness.snapshot(ConversationProjectDoc, context);
  return doc?.baseByConversation?.[String(conversationId)];
}

export async function originOf(
  harness: Harness,
  context: Context,
  conversationId: number,
): Promise<string | undefined> {
  const doc = await harness.snapshot(ConversationProjectDoc, context);
  return doc?.originByConversation?.[String(conversationId)];
}

export async function setOrigin(
  harness: Harness,
  context: Context,
  conversationId: number,
  branch: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ConversationProjectDoc);
    doc.originByConversation = { ...(doc.originByConversation ?? {}), [String(conversationId)]: branch };
    doc.baseByConversation = { ...(doc.baseByConversation ?? {}), [String(conversationId)]: branch };
  }, context);
}

export async function setBase(
  harness: Harness,
  context: Context,
  conversationId: number,
  branch: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ConversationProjectDoc);
    doc.baseByConversation = { ...(doc.baseByConversation ?? {}), [String(conversationId)]: branch };
  }, context);
}

export async function bindProject(
  harness: Harness,
  context: Context,
  conversationId: number,
  projectId: string,
): Promise<void> {
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ConversationProjectDoc);
    doc.byConversation[String(conversationId)] = projectId;
  }, context);
}

/** Registers the built-in sandbox the first time it is needed. */
export async function ensureBuiltinProject(
  harness: Harness,
  context: Context,
  workspacePath: string,
): Promise<Project> {
  const projects = await listProjects(harness, context);
  const existing = projects.find((project) => project.builtin === true);
  if (existing !== undefined) return existing;
  const project: Project = {
    id: "workspace",
    name: basename(workspacePath),
    path: workspacePath,
    builtin: true,
    createdAt: Date.now(),
  };
  await harness.commit(async (tx) => {
    const doc = await tx.doc(ProjectsDoc);
    doc.projects.push(project);
  }, context);
  log("project", "builtin project registered", { path: workspacePath });
  return project;
}

export type AddProjectResult =
  | { status: "added"; project: Project }
  | { status: "exists"; project: Project }
  | { status: "not-a-repo"; path: string }
  | { status: "missing"; path: string }
  | { status: "error"; message: string };

/** Adds a repository by path. Only existing git repos are accepted, never initialised. */
export async function addProject(
  harness: Harness,
  context: Context,
  rawPath: string,
): Promise<AddProjectResult> {
  const expanded = rawPath.startsWith("~") ? join(homedir(), rawPath.slice(1)) : rawPath;
  const path = resolve(isAbsolute(expanded) ? expanded : join(process.cwd(), expanded));
  if (!existsSync(path)) return { status: "missing", path };
  if (!existsSync(join(path, ".git"))) return { status: "not-a-repo", path };

  const projects = await listProjects(harness, context);
  const existing = projects.find((project) => project.path === path);
  if (existing !== undefined) return { status: "exists", project: existing };

  try {
    const remote = await run("git", ["-C", path, "remote", "get-url", "origin"]).catch(() => ({ stdout: "" }));
    const name = basename(path);
    const project: Project = {
      id: `${name}-${Date.now().toString(36)}`,
      name,
      path,
      createdAt: Date.now(),
    };
    await harness.commit(async (tx) => {
      const doc = await tx.doc(ProjectsDoc);
      doc.projects.push(project);
    }, context);
    await prepareProject(path);
    log("project", "added", { id: project.id, path, remote: remote.stdout.trim() });
    return { status: "added", project };
  } catch (error) {
    return { status: "error", message: (error as Error).message };
  }
}

export type RemoveProjectResult =
  | { status: "removed"; name: string; movedChats: number; movedConversations: number[] }
  | { status: "builtin" }
  | { status: "missing" };

/**
 * Forgets a project. The repo is never touched on disk — chats that lived in it move to
 * the built-in sandbox, because a conversation pointing at a deleted binding has no cwd.
 */
export async function removeProject(
  harness: Harness,
  context: Context,
  projectId: string,
): Promise<RemoveProjectResult> {
  const projects = await listProjects(harness, context);
  const target = projects.find((project) => project.id === projectId);
  if (target === undefined) return { status: "missing" };
  if (target.builtin === true) return { status: "builtin" };
  const fallback = projects.find((project) => project.builtin === true);

  const moved = await harness.commit(async (tx) => {
    const doc = await tx.doc(ProjectsDoc);
    doc.projects = doc.projects.filter((project) => project.id !== projectId);
    const bindings = await tx.doc(ConversationProjectDoc);
    const ids: number[] = [];
    if (fallback !== undefined) {
      for (const [conversationId, bound] of Object.entries(bindings.byConversation)) {
        if (bound !== projectId) continue;
        bindings.byConversation[conversationId] = fallback.id;
        ids.push(Number(conversationId));
      }
    }
    return ids;
  }, context);
  log("project", "removed", { id: projectId, path: target.path, movedChats: moved.length });
  return { status: "removed", name: target.name, movedChats: moved.length, movedConversations: moved };
}

/**
 * Creates the worktree directory and keeps it out of `git status` via the repo's own
 * info/exclude — a project's tracked .gitignore belongs to the user, not to us.
 */
export async function prepareProject(path: string): Promise<void> {
  await mkdir(join(path, ".worktrees"), { recursive: true });
  const exclude = join(path, ".git", "info", "exclude");
  try {
    const current = await readFile(exclude, "utf8").catch(() => "");
    if (!current.includes(".worktrees/")) {
      await mkdir(join(path, ".git", "info"), { recursive: true });
      await writeFile(exclude, `${current}${current.endsWith("\n") || current === "" ? "" : "\n"}.worktrees/\n`, "utf8");
    }
  } catch (error) {
    log("project", "could not extend info/exclude (worktrees may show in git status)", { path, error: String(error) });
  }
}
