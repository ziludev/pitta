// The page is the third surface on the durable agent: it reads the same
// conversation the Feishu bot writes, streams commits over a WebSocket, posts
// input back through the same admission rules, and shows workspace diffs.
import { Agent } from "./mygo";
import { applyI18n, currentLang, setLang, t, type Lang } from "./i18n";

type Entry = { id: number; kind: string; model: unknown; data: unknown };
type Surface = { surfaceId: string; conversationId: number };
type Task = { id: number; kind: string; conversationId: number; background: boolean; state: string };
type Note = { at: string; text: string };
type FileChange = { path: string; status: string; added: number; removed: number };
type Changes = {
  repo: boolean;
  diff: string;
  files: FileChange[];
  truncated: boolean;
  workspace?: string;
  error?: string;
};

type LiveValue = {
  entries?: Entry[];
  docs?: Record<string, Record<string, unknown>>;
};

const $ = <T extends HTMLElement>(selector: string): T => document.querySelector<T>(selector)!;

const baseURL = (await Agent.baseURL().catch(() => "http://127.0.0.1:8787")).replace(/\/$/, "");
const token = await Agent.token().catch(() => "");
const authHeaders: Record<string, string> = token ? { authorization: `Bearer ${token}` } : {};

let surfaces: Surface[] = [];
let current: number | undefined;
let socket: WebSocket | undefined;
let entries: Entry[] = [];
let seen = new Set<string>();
/** Follow the tail while streaming; stop as soon as the user scrolls up. */
let stick = true;
let busy = false;

function api<T>(path: string, init?: RequestInit): Promise<T> {
  return fetch(`${baseURL}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...authHeaders, ...(init?.headers ?? {}) },
  }).then((response) => {
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return response.json() as Promise<T>;
  });
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

/** Minimal markdown: fences, inline code, bold. No dependency, no XSS (escaped first). */
function renderMarkdown(text: string): string {
  const parts = escapeHtml(text).split(/```/);
  return parts
    .map((part, index) => {
      if (index % 2 === 1) {
        const body = part.replace(/^[a-zA-Z0-9]*\n/, "");
        return `<pre class="code">${body}</pre>`;
      }
      return part
        .replace(/`([^`]+)`/g, '<code class="inline">$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
        .replace(/\n/g, "<br />");
    })
    .join("");
}

function messageParts(model: unknown): Array<Record<string, unknown>> {
  const list = Array.isArray(model) ? model : [];
  const parts: Array<Record<string, unknown>> = [];
  for (const message of list as Array<Record<string, unknown>>) {
    const content = message["content"];
    if (typeof content === "string") parts.push({ type: "text", text: content });
    else if (Array.isArray(content)) {
      for (const part of content as Array<Record<string, unknown>>) {
        parts.push({ ...part, role: message["role"], toolName: message["toolName"] });
      }
    }
  }
  return parts;
}

function textOf(parts: Array<Record<string, unknown>>): string {
  return parts
    .filter((part) => part["type"] === "text")
    .map((part) => String(part["text"] ?? ""))
    .join("");
}

function renderEntry(entry: Entry): string {
  const parts = messageParts(entry.model);
  const text = textOf(parts);
  const thinking = parts
    .filter((part) => part["type"] === "thinking")
    .map((part) => String(part["thinking"] ?? ""))
    .join("\n");

  if (entry.kind === "pi.user") {
    const images = parts.filter((part) => part["type"] === "image").length;
    return `<div class="msg user"><div class="bubble">${renderMarkdown(text)}${
      images > 0 ? `<div class="tiny muted">[${images} ${t("images")}]</div>` : ""
    }</div></div>`;
  }

  if (entry.kind === "pi.assistant") {
    const calls = parts
      .filter((part) => part["type"] === "toolCall")
      .map((part) => `<span class="chip">${escapeHtml(String(part["name"] ?? ""))}</span>`)
      .join("");
    return `<div class="msg assistant">${calls ? `<div class="chips">${calls}</div>` : ""}${
      text ? `<div class="bubble">${renderMarkdown(text)}</div>` : ""
    }${
      thinking
        ? `<details class="thinking"><summary>${t("thinking")}</summary><pre>${escapeHtml(thinking)}</pre></details>`
        : ""
    }</div>`;
  }

  if (entry.kind === "pi.tool-result") {
    const name = String(parts[0]?.["toolName"] ?? "tool");
    const body = text.length > 4000 ? `${text.slice(0, 4000)}\n…` : text;
    return `<div class="msg tool"><details><summary>${escapeHtml(name)} · ${t("output")}</summary><pre>${escapeHtml(
      body,
    )}</pre></details></div>`;
  }

  if (entry.kind === "app.feature-report") {
    const payload = (entry.data ?? {}) as { text?: string };
    return `<div class="msg note"><details open><summary>🧩 ${t("featureReport")}</summary><div class="bubble">${renderMarkdown(
      payload.text ?? "",
    )}</div></details></div>`;
  }

  if (entry.kind === "pi.system") return "";
  return `<div class="msg system">${escapeHtml(entry.kind)}</div>`;
}

function renderTranscript(live?: LiveValue): void {
  const list = live?.entries ?? entries;
  const box = $("#transcript");
  const follow = stick;
  box.innerHTML = list.map(renderEntry).join("");

  const liveState = live?.docs?.["pi.live"];
  if (liveState !== undefined) {
    const tools = Array.isArray(liveState["tools"])
      ? (liveState["tools"] as Array<Record<string, unknown>>)
      : [];
    const running = tools.find((slot) => slot["status"] === "running");
    const partial = textOf(
      messageParts((liveState["generation"] as Record<string, unknown> | undefined)?.["message"]),
    );
    const tail = running
      ? String((running["output"] as string | undefined) ?? "")
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .pop() ?? ""
      : "";
    if (running !== undefined || partial.length > 0) {
      box.insertAdjacentHTML(
        "beforeend",
        `<div class="msg assistant live">
           ${running ? `<div class="chips"><span class="chip active">${escapeHtml(String(running["name"] ?? ""))}</span></div>` : ""}
           ${partial ? `<div class="bubble">${renderMarkdown(partial)}</div>` : ""}
           ${tail ? `<div class="tiny muted">${escapeHtml(tail.slice(0, 160))}</div>` : ""}
         </div>`,
      );
    }
  }
  if (follow) box.scrollTop = box.scrollHeight;
}

function setBusy(next: boolean): void {
  busy = next;
  const status = $("#status");
  status.dataset["busy"] = next ? "1" : "0";
  status.textContent = next ? t("busy") : t("idle");
}

function connect(conversationId: number): void {
  socket?.close();
  const wsBase = baseURL.replace(/^http/, "ws");
  const url = `${wsBase}/ws?conversationId=${conversationId}${token ? `&token=${encodeURIComponent(token)}` : ""}`;
  socket = new WebSocket(url);
  socket.onmessage = (event) => {
    const frame = JSON.parse(event.data as string) as { value?: LiveValue };
    if (frame.value === undefined) return;
    const live = frame.value;
    if (live.entries !== undefined) entries = live.entries;
    setBusy(live.docs?.["pi.live"]?.["run"] !== undefined);
    renderTranscript(live);
  };
  socket.onerror = () => ($("#status").textContent = t("bridgeFailed"));
  socket.onclose = () => {
    if (!busy) $("#status").textContent = t("disconnected");
  };
}

async function loadSurfaces(): Promise<void> {
  const state = await api<{ surfaces: Surface[]; tasks: Task[]; usage: unknown }>("/api/state");
  surfaces = state.surfaces.sort((a, b) => a.conversationId - b.conversationId);
  renderSurfaces();
  renderTasks(state.tasks);
  $("#usage").textContent = `${t("cumulative")} $${totalCost(state.usage).toFixed(4)}`;
}

function totalCost(usage: unknown): number {
  let total = 0;
  const buckets = (usage ?? {}) as Record<string, Record<string, { cost?: Record<string, number> }>>;
  for (const bucket of Object.values(buckets)) {
    for (const entry of Object.values(bucket ?? {})) {
      const cost = entry?.cost;
      if (cost === undefined) continue;
      total += cost["total"] ?? (cost["input"] ?? 0) + (cost["output"] ?? 0);
    }
  }
  return total;
}

function surfaceLabel(surfaceId: string): string {
  return surfaceId.startsWith("oc_") ? `${t("feishu")} ${surfaceId.slice(3, 9)}` : surfaceId;
}

function renderSurfaces(): void {
  $("#surfaces").innerHTML = surfaces
    .map(
      (surface) => `<li data-id="${surface.conversationId}" class="${
        surface.conversationId === current ? "active" : ""
      }">
        <span class="label">${escapeHtml(surfaceLabel(surface.surfaceId))}</span>
        <span class="muted tiny">#${surface.conversationId}</span>
      </li>`,
    )
    .join("");
}

function renderTasks(tasks: Task[]): void {
  const live = tasks.filter((task) => !task.kind.startsWith("pi."));
  $("#tasks").innerHTML =
    live.length === 0
      ? `<li class="muted tiny">${t("noTasks")}</li>`
      : live
          .map(
            (task) =>
              `<li><span class="label">${escapeHtml(task.kind)}</span> <span class="muted tiny">#${task.id} ${escapeHtml(task.state)}</span></li>`,
          )
          .join("");
}

async function select(conversationId: number): Promise<void> {
  current = conversationId;
  stick = true;
  renderSurfaces();
  const data = await api<{ entries: Entry[] }>(`/api/conversation?id=${conversationId}&limit=200`);
  entries = data.entries;
  $("#conv-title").textContent = `#${conversationId}`;
  $("#conv-sub").textContent =
    surfaces.find((surface) => surface.conversationId === conversationId)?.surfaceId ?? "";
  renderTranscript();
  connect(conversationId);
  void loadMemory(conversationId);
  void loadChanges();
}

async function loadMemory(conversationId?: number): Promise<void> {
  const memory = await api<{ global: Note[]; work: Note[]; chat: Note[] }>(
    `/api/memory${conversationId === undefined ? "" : `?chat=${conversationId}`}`,
  );
  $("#mem-count").textContent = `${memory.global.length} ${t("globals")} · ${memory.work.length} ${t(
    "work",
  )} · ${memory.chat.length} ${t("chat")}`;
  const block = (title: string, notes: Note[]) =>
    notes.length === 0
      ? ""
      : `<div class="mem-group"><div class="mem-title">${title}</div>${notes
          .slice(-8)
          .map((note) => `<div class="mem-item">${escapeHtml(note.text.slice(0, 220))}</div>`)
          .join("")}</div>`;
  $("#memory").innerHTML =
    block(t("globals"), memory.global) + block(t("work"), memory.work) + block(t("chat"), memory.chat) ||
    `<div class="muted tiny">${t("noMemory")}</div>`;
}

const STATUS_TEXT: Record<string, string> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  conflicted: "conflicted",
  untracked: "untracked",
  clean: "clean",
};

function statusLabel(status: string): string {
  const key = STATUS_TEXT[status];
  if (key === undefined) return status;
  return t(key as never);
}

/** Renders one unified diff: per-file collapsible blocks with +/− line classes. */
function renderDiff(diff: string): string {
  if (diff.trim().length === 0) return "";
  const blocks = diff.split(/^(?=diff --git )/m).filter((block) => block.trim().length > 0);
  return blocks
    .map((block) => {
      const lines = block.split("\n");
      const header = lines.find((line) => line.startsWith("diff --git ")) ?? "";
      const match = /b\/(.+)$/.exec(header);
      const path = match?.[1] ?? header.replace("diff --git ", "");
      const body = lines
        .filter(
          (line) =>
            !line.startsWith("diff --git ") &&
            !line.startsWith("index ") &&
            !line.startsWith("--- ") &&
            !line.startsWith("+++ "),
        )
        .slice(0, 600)
        .map((line) => {
          const cls = line.startsWith("@@")
            ? "hunk"
            : line.startsWith("+")
              ? "add"
              : line.startsWith("-")
                ? "del"
                : "ctx";
          return `<span class="dl ${cls}">${escapeHtml(line)}</span>`;
        })
        .join("");
      return `<details class="file" open><summary>${escapeHtml(path)}</summary><pre class="diff-body">${body}</pre></details>`;
    })
    .join("");
}

async function loadChanges(): Promise<void> {
  const box = $("#changes");
  try {
    const changes = await api<Changes>("/api/changes");
    if (!changes.repo) {
      box.innerHTML = `<div class="muted tiny">${t("noChanges")}</div>`;
      $("#changes-summary").textContent = "";
      return;
    }
    const total = changes.files.length;
    $("#changes-summary").textContent =
      total === 0 ? t("noChanges") : `${total} file${total === 1 ? "" : "s"} · ${changes.truncated ? t("truncated") : ""}`;
    box.innerHTML =
      total === 0
        ? `<div class="muted tiny">${t("noChanges")}</div>`
        : changes.files
            .map(
              (file) =>
                `<div class="file-row"><span class="fstat ${file.status}">${statusLabel(file.status)}</span>
                 <span class="fpath">${escapeHtml(file.path)}</span>
                 <span class="muted tiny">${file.added > 0 ? `+${file.added}` : ""}${
                   file.removed > 0 ? ` −${file.removed}` : ""
                 }</span></div>`,
            )
            .join("") + renderDiff(changes.diff);
  } catch (error) {
    box.innerHTML = `<div class="muted tiny">${escapeHtml((error as Error).message)}</div>`;
  }
}

async function send(): Promise<void> {
  if (current === undefined) return;
  const input = $<HTMLTextAreaElement>("#input");
  const text = input.value.trim();
  if (text.length === 0) return;
  input.value = "";
  const mode = $<HTMLInputElement>("#steer").checked ? "steer" : "followUp";
  await api("/api/submit", {
    method: "POST",
    body: JSON.stringify({ conversationId: current, text, mode }),
  });
}

// ---- wiring ---------------------------------------------------------------

$("#transcript").addEventListener("scroll", () => {
  const box = $("#transcript");
  // 80px of slack: the tail counts as "at the bottom" while it wraps.
  stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
});

$("#surfaces").addEventListener("click", (event) => {
  const item = (event.target as HTMLElement).closest("li[data-id]");
  if (item === null) return;
  void select(Number((item as HTMLElement).dataset["id"]));
});

$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  void send();
});

$("#input").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    void send();
  }
});

$("#abort").addEventListener("click", () => {
  if (current === undefined) return;
  void api("/api/abort", { method: "POST", body: JSON.stringify({ conversationId: current }) }).catch(() => {});
});

$("#reset").addEventListener("click", () => {
  if (current === undefined) return;
  void api("/api/reset", { method: "POST", body: JSON.stringify({ conversationId: current }) }).catch(() => {});
});

document.querySelectorAll<HTMLButtonElement>("button[data-control]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset["control"] ?? "";
    button.disabled = true;
    try {
      const output = await Agent.control(action).catch(() => t("onlyDesktop"));
      $("#status").textContent = output.split("\n")[0]?.slice(0, 40) || action;
    } finally {
      button.disabled = false;
    }
  });
});

$("#open-logs").addEventListener("click", () => void Agent.openLogs().catch(() => {}));

$("#changes-refresh").addEventListener("click", () => void loadChanges());
$("#changes-commit").addEventListener("click", async () => {
  const message = window.prompt(t("commitPlaceholder"), "");
  if (message === null) return;
  try {
    const result = await api<{ head: string }>("/api/commit", {
      method: "POST",
      body: JSON.stringify({ message: message.trim() || undefined }),
    });
    $("#changes-summary").textContent = `${t("committed")} ${result.head}`;
    await loadChanges();
  } catch {
    $("#changes-summary").textContent = t("nothingToCommit");
  }
});

document.querySelectorAll<HTMLButtonElement>(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    const name = tab.dataset["tab"];
    document.querySelectorAll(".tab").forEach((other) => other.classList.toggle("active", other === tab));
    $("#panel-changes").classList.toggle("hidden", name !== "changes");
    $("#panel-memory").classList.toggle("hidden", name !== "memory");
    if (name === "changes") void loadChanges();
  });
});

$("#lang").addEventListener("click", () => {
  const next: Lang = currentLang() === "zh" ? "en" : "zh";
  setLang(next);
  $("#lang").textContent = next === "zh" ? "EN" : "中";
  void refreshText();
});

/** Language switched: re-render everything that carries a label. */
async function refreshText(): Promise<void> {
  setBusy(busy);
  renderSurfaces();
  renderTranscript();
  await loadSurfaces().catch(() => {});
  if (current !== undefined) await loadMemory(current).catch(() => {});
  await loadChanges().catch(() => {});
}

// ---- boot -----------------------------------------------------------------

applyI18n();
$("#lang").textContent = currentLang() === "zh" ? "EN" : "中";
$("#home").textContent = await Agent.home().catch(() => "browser");
$("#status").textContent = t("connecting");
await loadSurfaces();
setBusy(false);
if (surfaces.length > 0) void select(surfaces[surfaces.length - 1]!.conversationId);

setInterval(() => {
  void loadSurfaces().catch(() => {});
  if (current !== undefined) void loadMemory(current).catch(() => {});
  if (!$("#panel-changes").classList.contains("hidden")) void loadChanges().catch(() => {});
}, 15_000);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && current !== undefined && socket?.readyState !== WebSocket.OPEN) connect(current);
});

void seen;
