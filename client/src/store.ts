import { create } from "zustand";
import {
  api,
  baseURL,
  controlAgent,
  homeDir,
  wsURL,
  type Changes,
  type Entry,
  type Note,
  type Surface,
  type Task,
} from "@/lib/api";
import { initialLang, type Lang } from "@/i18n";
import { setErrorSink } from "@/lib/api";
import type {
  Project,
  MemorySuggestion,
  MergeResult,
  ModelEntry,
  ModelRef,
  PendingApproval,
  UsageDay,
} from "@/lib/api";

export type LiveDoc = {
  run?: unknown;
  generation?: { message?: unknown };
  tools?: Array<Record<string, unknown>>;
};

export type Connection = "connecting" | "open" | "closed" | "failed";

type State = {
  lang: Lang;
  home: string;
  connection: Connection;
  busy: boolean;
  surfaces: Surface[];
  projects: Project[];
  /** Which project the rail is scoped to. */
  currentProject: string;
  tasks: Task[];
  current?: number;
  entries: Entry[];
  live?: LiveDoc;
  memory: { global: Note[]; work: Note[]; chat: Note[] };
  changes?: Changes;
  changesLoading: boolean;
  order: number[];
  pinned: number[];
  tab: "changes" | "memory";
  focusEntry?: number;
  /** Middle pane: the transcript, or one workspace file. */
  view: { kind: "transcript" } | { kind: "file"; path: string };
  filter: string;
  review: Array<{ path: string; line: string; note: string }>;
  model?: ModelRef;
  thinkingLevel?: string;
  models: ModelEntry[];
  modelsLoadedAt?: number;
  favorites: string[];
  recents: string[];
  usageDays: UsageDay[];
  memoryQuery: string;
  /** Which surfaces the rail shows: everything, only this app's chats, or only Feishu. */
  surfaceFilter: "all" | "client" | "feishu";
  memorySuggestions: MemorySuggestion[];
  curating: boolean;
  approvals: PendingApproval[];
  /** In-conversation search. */
  convQuery: string;
  convMatchIndex: number;
  convMatches: number[];
  /** Recent client-side failures, newest last (the log file is not visible in-app). */
  errors: Array<{ at: string; message: string }>;

  init(): Promise<void>;
  select(conversationId: number): Promise<void>;
  refreshSurfaces(): Promise<void>;
  loadMemory(): Promise<void>;
  loadChanges(): Promise<void>;
  submit(text: string, mode: "followUp" | "steer"): Promise<void>;
  abort(): Promise<void>;
  reset(): Promise<void>;
  commit(message: string): Promise<string>;
  merge(): Promise<MergeResult>;
  askAgentToResolve(result: MergeResult): Promise<void>;
  control(action: "start" | "stop" | "restart" | "backup"): Promise<string>;
  openLogs(): Promise<void>;
  setLang(lang: Lang): void;
  setOrder(order: number[]): void;
  togglePin(conversationId: number): void;
  setTab(tab: "changes" | "memory"): void;
  openFile(path: string): void;
  closeFile(): void;
  setFilter(filter: string): void;
  setFocusEntry(entryId: number | undefined): void;
  addReviewComment(input: { path: string; line: string; note: string }): void;
  removeReviewComment(index: number): void;
  clearReview(): void;
  sendReview(): Promise<void>;
  loadModels(force?: boolean): Promise<void>;
  toggleFavorite(key: string): void;
  rememberRecent(key: string): void;
  setDefaultModel(input: { provider: string; modelId: string; thinkingLevel?: string }): Promise<void>;
  setModel(input: { provider: string; modelId: string; thinkingLevel?: string }): Promise<void>;
  loadUsage(): Promise<void>;
  setMemoryQuery(query: string): void;
  setSurfaceFilter(filter: "all" | "client" | "feishu"): void;
  showArchived: boolean;
  toggleShowArchived(): void;
  newChat(): Promise<number>;
  setProject(projectId: string): void;
  openProject(path: string): Promise<{ status: string; project?: Project; path?: string }>;
  renameChat(conversationId: number, title: string): Promise<void>;
  archiveChat(conversationId: number, archived: boolean): Promise<void>;
  cleanupWorktree(conversationId: number): Promise<{ status: string; commits?: number }>;
  curateMemory(hours?: number): Promise<{ scanned: number; suggested: number }>;
  applySuggestions(accepted: MemorySuggestion[]): Promise<{ added: number; skipped: number }>;
  clearSuggestions(): void;
  loadApprovals(): Promise<void>;
  setConvQuery(query: string): void;
  pushError(message: string): void;
  clearErrors(): void;
  setConvMatches(ids: number[]): void;
  stepMatch(direction: 1 | -1): void;
  decideApproval(callId: string, approved: boolean): Promise<void>;
};

let socket: WebSocket | undefined;

const ORDER_KEY = "agent.surfaceOrder";
const PIN_KEY = "agent.pinned";

function savedPinned(): number[] {
  try {
    return JSON.parse(localStorage.getItem(PIN_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

function savedOrder(): number[] {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as number[];
  } catch {
    return [];
  }
}

export const useStore = create<State>((set, get) => ({
  // Wired once: any failed API call lands in the panel.
  ...(() => {
    setErrorSink((message) => get().pushError(message));
    return {};
  })(),
  lang: initialLang(),
  home: "",
  connection: "connecting",
  busy: false,
  surfaces: [],
  projects: [],
  currentProject: localStorage.getItem("agent.project") ?? "workspace",
  tasks: [],
  entries: [],
  memory: { global: [], work: [], chat: [] },
  changesLoading: false,
  order: savedOrder(),
  pinned: savedPinned(),
  tab: (["changes", "usage", "memory"] as const).includes(
    new URLSearchParams(location.search).get("tab") as never,
  )
    ? (new URLSearchParams(location.search).get("tab") as "changes" | "memory")
    : "changes",
  focusEntry: Number(new URLSearchParams(location.search).get("entry") ?? "") || undefined,
  view: new URLSearchParams(location.search).get("file")
    ? { kind: "file", path: new URLSearchParams(location.search).get("file")! }
    : { kind: "transcript" },
  filter: "",
  review: [],
  models: [],
  usageDays: [],
  memoryQuery: "",
  surfaceFilter: (localStorage.getItem("agent.surfaceFilter") as "all" | "client" | "feishu" | null) ?? "all",
  showArchived: false,
  memorySuggestions: [],
  curating: false,
  approvals: [],
  convQuery: "",
  convMatchIndex: 0,
  convMatches: [],
  errors: [],
  favorites: JSON.parse(localStorage.getItem("agent.favoriteModels") ?? "[]") as string[],
  recents: JSON.parse(localStorage.getItem("agent.recentModels") ?? "[]") as string[],

  async init() {
    set({ home: homeDir });
    await get().refreshSurfaces();
    await get().loadChanges();
    const { surfaces, order } = get();
    const sorted = [...surfaces].sort((a, b) => {
      const ai = order.indexOf(a.conversationId);
      const bi = order.indexOf(b.conversationId);
      if (ai !== -1 && bi !== -1) return ai - bi;
      return a.conversationId - b.conversationId;
    });
    const requested = Number(new URLSearchParams(location.search).get("conv") ?? "");
    const target =
      Number.isFinite(requested) && requested > 0 && sorted.some((item) => item.conversationId === requested)
        ? requested
        : sorted[sorted.length - 1]?.conversationId;
    if (target !== undefined) await get().select(target);
    // ?q= ... deep links a search inside the conversation.
    const query = new URLSearchParams(location.search).get("q");
    if (query !== null && query.trim().length >= 2) get().setConvQuery(query);
    setInterval(() => {
      void get()
        .refreshSurfaces()
        .catch(() => {});
      void get()
        .loadMemory()
        .catch(() => {});
      if (get().tab === "changes") {
        void get()
          .loadChanges()
          .catch(() => {});
      }
      // Approvals block a run until someone answers, so poll faster than the rest.
      void get()
        .loadApprovals()
        .catch(() => {});
    }, 15_000);

    void get().loadApprovals().catch(() => {});
    setInterval(() => {
      void get()
        .loadApprovals()
        .catch(() => {});
    }, 5_000);
  },

  async refreshSurfaces() {
    const state = await api<{ surfaces: Surface[]; tasks: Task[]; projects?: Project[] }>("/api/state");
    set({
      surfaces: state.surfaces,
      tasks: state.tasks,
      projects: state.projects ?? get().projects,
    });
  },

  setProject(projectId) {
    localStorage.setItem("agent.project", projectId);
    set({ currentProject: projectId });
  },

  async openProject(path) {
    const result = await api<{ status: string; project?: Project; path?: string }>("/api/projects", {
      method: "POST",
      body: JSON.stringify({ path }),
    });
    await get().refreshSurfaces();
    const project = result.project ?? get().projects.find((entry) => entry.path === path);
    if (project !== undefined) get().setProject(project.id);
    return result;
  },

  async select(conversationId) {
    socket?.close();
    set({ current: conversationId, connection: "connecting", entries: [], live: undefined });
    const projectId = get().surfaces.find((surface) => surface.conversationId === conversationId)?.projectId;
    if (projectId !== undefined && projectId !== get().currentProject) get().setProject(projectId);
    const data = await api<{ entries: Entry[]; model?: ModelRef; thinkingLevel?: string }>(
      `/api/conversation?id=${conversationId}&limit=200`,
    );
    set({ entries: data.entries, model: data.model, thinkingLevel: data.thinkingLevel ?? undefined });

    socket = new WebSocket(wsURL(conversationId));
    socket.onopen = () => set({ connection: "open" });
    socket.onmessage = (event) => {
      const frame = JSON.parse(event.data as string) as {
        value?: { entries?: Entry[]; docs?: Record<string, LiveDoc> };
      };
      const value = frame.value;
      if (value === undefined) return;
      set({
        entries: value.entries ?? get().entries,
        live: value.docs?.["pi.live"],
        busy: value.docs?.["pi.live"]?.run !== undefined,
      });
    };
    socket.onerror = () => set({ connection: "failed" });
    socket.onclose = () => set({ connection: "closed" });

    await Promise.all([get().loadMemory(), get().loadChanges()]);
  },

  async loadMemory() {
    const id = get().current;
    const memory = await api<{ global: Note[]; work: Note[]; chat: Note[] }>(
      `/api/memory${id === undefined ? "" : `?chat=${id}`}`,
    );
    set({ memory });
  },

  async loadChanges() {
    set({ changesLoading: true });
    try {
      const id = get().current;
      const changes = await api<Changes>(`/api/changes${id === undefined ? "" : `?conversationId=${id}`}`);
      set({ changes });
    } finally {
      set({ changesLoading: false });
    }
  },

  async submit(text, mode) {
    const id = get().current;
    if (id === undefined || text.trim().length === 0) return;
    await api("/api/submit", {
      method: "POST",
      body: JSON.stringify({ conversationId: id, text, mode }),
    });
  },

  async abort() {
    const id = get().current;
    if (id === undefined) return;
    await api("/api/abort", { method: "POST", body: JSON.stringify({ conversationId: id }) });
  },

  async reset() {
    const id = get().current;
    if (id === undefined) return;
    await api("/api/reset", { method: "POST", body: JSON.stringify({ conversationId: id }) });
  },

  async commit(message) {
    const result = await api<{ head: string }>("/api/commit", {
      method: "POST",
      body: JSON.stringify({ message: message.trim() || undefined, conversationId: get().current }),
    });
    await get().loadChanges();
    return result.head;
  },

  control: (action) => controlAgent(action),

  async merge() {
    const id = get().current;
    if (id === undefined) throw new Error("no conversation");
    const result = await api<MergeResult>("/api/merge", {
      method: "POST",
      body: JSON.stringify({ conversationId: id }),
    });
    await Promise.all([get().loadChanges(), get().loadMemory()]).catch(() => {});
    return result;
  },

  /** Conflicts come back as data; hand them to the agent instead of guessing. */
  async askAgentToResolve(result) {
    const id = get().current;
    if (id === undefined) return;
    const files = result.status === "conflict" ? result.conflicts : [];
    await api("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        conversationId: id,
        text:
          `把分支 ${"branch" in result ? result.branch : ""} 合并到 ${"base" in result ? result.base : "主线"} 时出现冲突：\n` +
          files.map((file) => `- ${file}`).join("\n") +
          "\n请在当前 worktree 里解决冲突（可以 git merge 主线到本分支来就地解决），跑通验证，然后提交。",
        mode: "followUp",
      }),
    });
  },

  async openLogs() {
    const { Agent } = await import("@/mygo");
    await Agent.openLogs().catch(() => {});
    void baseURL;
  },

  setLang(lang) {
    localStorage.setItem("agent.lang", lang);
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
    set({ lang });
  },

  setOrder(order) {
    localStorage.setItem(ORDER_KEY, JSON.stringify(order));
    set({ order });
  },

  togglePin(conversationId) {
    const pinned = get().pinned.includes(conversationId)
      ? get().pinned.filter((id) => id !== conversationId)
      : [...get().pinned, conversationId];
    localStorage.setItem(PIN_KEY, JSON.stringify(pinned));
    set({ pinned });
  },

  setTab(tab) {
    set({ tab });
    if (tab === "changes") void get().loadChanges().catch(() => {});
  },

  openFile(path) {
    set({ view: { kind: "file", path } });
  },

  closeFile() {
    set({ view: { kind: "transcript" } });
  },

  setFilter(filter) {
    set({ filter });
  },

  setFocusEntry(entryId) {
    set({ focusEntry: entryId, view: { kind: "transcript" } });
  },

  addReviewComment(input) {
    set({ review: [...get().review, input] });
  },

  removeReviewComment(index) {
    set({ review: get().review.filter((_, at) => at !== index) });
  },

  clearReview() {
    set({ review: [] });
  },

  async loadModels(force = false) {
    if (!force && get().models.length > 0) return;
    const result = await api<{ models: ModelEntry[] }>("/api/models");
    set({ models: result.models, modelsLoadedAt: Date.now() });
  },

  toggleFavorite(key) {
    const favorites = get().favorites.includes(key)
      ? get().favorites.filter((item) => item !== key)
      : [...get().favorites, key];
    localStorage.setItem("agent.favoriteModels", JSON.stringify(favorites));
    set({ favorites });
  },

  rememberRecent(key) {
    const recents = [key, ...get().recents.filter((item) => item !== key)].slice(0, 6);
    localStorage.setItem("agent.recentModels", JSON.stringify(recents));
    set({ recents });
  },

  async setDefaultModel(input) {
    await api("/api/default-model", { method: "POST", body: JSON.stringify(input) });
  },

  async setModel(input) {
    const id = get().current;
    if (id === undefined) return;
    await api("/api/model", {
      method: "POST",
      body: JSON.stringify({ conversationId: id, ...input }),
    });
    set({ model: { provider: input.provider, modelId: input.modelId }, thinkingLevel: input.thinkingLevel });
    get().rememberRecent(`${input.provider}/${input.modelId}`);
  },

  async loadUsage() {
    const result = await api<{ days: UsageDay[] }>("/api/usage-calendar?days=120");
    set({ usageDays: result.days });
  },

  setMemoryQuery(query) {
    set({ memoryQuery: query });
  },

  setSurfaceFilter(filter) {
    localStorage.setItem("agent.surfaceFilter", filter);
    set({ surfaceFilter: filter });
  },

  toggleShowArchived() {
    set({ showArchived: !get().showArchived });
  },

  async renameChat(conversationId, title) {
    await api("/api/surface-meta", {
      method: "POST",
      body: JSON.stringify({ conversationId, title: title.trim().length === 0 ? null : title }),
    });
    await get().refreshSurfaces();
  },

  async archiveChat(conversationId, archived) {
    await api("/api/surface-meta", {
      method: "POST",
      body: JSON.stringify({ conversationId, archived }),
    });
    await get().refreshSurfaces();
  },

  async cleanupWorktree(conversationId) {
    const result = await api<{ status: string; commits?: number }>("/api/worktree/remove", {
      method: "POST",
      body: JSON.stringify({ conversationId }),
    });
    await get().loadChanges();
    return result;
  },

  async newChat() {
    const result = await api<{ conversationId: number; surfaceId: string }>("/api/conversations", {
      method: "POST",
      body: JSON.stringify({ projectId: get().currentProject }),
    });
    await get().refreshSurfaces();
    await get().select(result.conversationId);
    return result.conversationId;
  },

  async curateMemory(hours = 24) {
    set({ curating: true });
    try {
      const result = await api<{ suggestions: MemorySuggestion[]; scanned: number }>("/api/memory/curate", {
        method: "POST",
        body: JSON.stringify({ hours }),
      });
      set({ memorySuggestions: result.suggestions });
      return { scanned: result.scanned, suggested: result.suggestions.length };
    } finally {
      set({ curating: false });
    }
  },

  async applySuggestions(accepted) {
    const result = await api<{ added: number; skipped: number }>("/api/memory/apply", {
      method: "POST",
      body: JSON.stringify({ suggestions: accepted }),
    });
    set({ memorySuggestions: [] });
    await get().loadMemory();
    return result;
  },

  clearSuggestions() {
    set({ memorySuggestions: [] });
  },

  pushError(message) {
    const at = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    const errors = [...get().errors, { at, message }].slice(-30);
    set({ errors });
  },

  clearErrors() {
    set({ errors: [] });
  },

  setConvQuery(query) {
    set({ convQuery: query, convMatchIndex: 0, convMatches: [] });
  },

  setConvMatches(ids) {
    if (ids.length === get().convMatches.length && ids.every((id, index) => id === get().convMatches[index])) return;
    set({ convMatches: ids, convMatchIndex: 0 });
    if (ids.length > 0) get().setFocusEntry(ids[0]);
  },

  stepMatch(direction) {
    const { convMatches, convMatchIndex } = get();
    if (convMatches.length === 0) return;
    const next = (convMatchIndex + direction + convMatches.length) % convMatches.length;
    set({ convMatchIndex: next });
    get().setFocusEntry(convMatches[next]!);
  },

  async loadApprovals() {
    const result = await api<{ approvals: PendingApproval[] }>("/api/approvals");
    const known = new Set(get().approvals.map((entry) => entry.callId));
    const fresh = result.approvals.some((entry) => !known.has(entry.callId));
    set({ approvals: result.approvals });
    // A new approval should surface even if the user is reading history.
    if (fresh) set({ focusApprovalAt: Date.now() } as never);
  },

  async decideApproval(callId, approved) {
    await api("/api/approvals", { method: "POST", body: JSON.stringify({ callId, approved }) });
    set({ approvals: get().approvals.filter((entry) => entry.callId !== callId) });
  },

  /** Anchored comments go to the agent as one review message, like a PR review. */
  async sendReview() {
    const { review, current } = get();
    if (current === undefined || review.length === 0) return;
    const body = review
      .map((item, index) => `${index + 1}. ${item.path}\n   ${item.line.trim().slice(0, 200)}\n   → ${item.note}`)
      .join("\n\n");
    await api("/api/submit", {
      method: "POST",
      body: JSON.stringify({
        conversationId: current,
        text: `工作区改动上的评审意见，请逐条处理：\n\n${body}`,
        mode: "followUp",
      }),
    });
    set({ review: [] });
  },
}));
