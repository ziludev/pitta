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

  init(): Promise<void>;
  select(conversationId: number): Promise<void>;
  refreshSurfaces(): Promise<void>;
  loadMemory(): Promise<void>;
  loadChanges(): Promise<void>;
  submit(text: string, mode: "followUp" | "steer"): Promise<void>;
  abort(): Promise<void>;
  reset(): Promise<void>;
  commit(message: string): Promise<string>;
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
  lang: initialLang(),
  home: "",
  connection: "connecting",
  busy: false,
  surfaces: [],
  tasks: [],
  entries: [],
  memory: { global: [], work: [], chat: [] },
  changesLoading: false,
  order: savedOrder(),
  pinned: savedPinned(),
  tab: "changes",
  focusEntry: Number(new URLSearchParams(location.search).get("entry") ?? "") || undefined,
  view: new URLSearchParams(location.search).get("file")
    ? { kind: "file", path: new URLSearchParams(location.search).get("file")! }
    : { kind: "transcript" },
  filter: "",
  review: [],

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
    }, 15_000);
  },

  async refreshSurfaces() {
    const state = await api<{ surfaces: Surface[]; tasks: Task[] }>("/api/state");
    set({ surfaces: state.surfaces, tasks: state.tasks });
  },

  async select(conversationId) {
    socket?.close();
    set({ current: conversationId, connection: "connecting", entries: [], live: undefined });
    const data = await api<{ entries: Entry[] }>(`/api/conversation?id=${conversationId}&limit=200`);
    set({ entries: data.entries });

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
      const changes = await api<Changes>("/api/changes");
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
      body: JSON.stringify({ message: message.trim() || undefined }),
    });
    await get().loadChanges();
    return result.head;
  },

  control: (action) => controlAgent(action),

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
