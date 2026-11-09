import { Agent } from "@/mygo";

export type Surface = { surfaceId: string; conversationId: number };
export type Task = { id: number; kind: string; conversationId: number; background: boolean; state: string };
export type Entry = { id: number; kind: string; model: unknown; data: unknown };
export type Note = { at: string; text: string };
export type FileChange = { path: string; status: string; added: number; removed: number };
export type Changes = {
  repo: boolean;
  branch?: string;
  diff: string;
  files: FileChange[];
  truncated: boolean;
  workspace?: string;
  error?: string;
};

/** Inside the MyGo window Go supplies these; in a plain browser fall back to the default bridge. */
export const baseURL = (await Agent.baseURL().catch(() => "http://127.0.0.1:8787")).replace(/\/$/, "");
export const token = await Agent.token().catch(() => "");
export const homeDir = await Agent.home().catch(() => "browser");

const auth: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${baseURL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...auth, ...(init?.headers ?? {}) },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return (await response.json()) as T;
}

export const wsURL = (conversationId: number): string =>
  `${baseURL.replace(/^http/, "ws")}/ws?conversationId=${conversationId}${
    token ? `&token=${encodeURIComponent(token)}` : ""
  }`;

export async function controlAgent(action: "start" | "stop" | "restart" | "backup"): Promise<string> {
  return Agent.control(action).catch(() => "");
}
