/**
 * Two languages, no dependency: a flat dictionary and a `t()` that reads the
 * current one. Everything user-visible goes through here so a screenshot in
 * either language stays honest.
 */
export type Lang = "zh" | "en";

const dict = {
  zh: {
    sessions: "会话",
    running: "运行中",
    changes: "改动",
    memory: "记忆",
    noTasks: "没有后台任务",
    noMemory: "没有记忆",
    noChanges: "工作区没有改动",
    loadChanges: "读取改动…",
    commit: "提交",
    commitPlaceholder: "提交说明",
    truncated: "（diff 已截断）",
    untracked: "新文件",
    modified: "已修改",
    added: "已新增",
    deleted: "已删除",
    renamed: "已重命名",
    conflicted: "有冲突",
    cumulative: "累计",
    restart: "重启",
    backup: "备份",
    logs: "日志",
    newConv: "/new",
    stop: "/stop",
    idle: "空闲",
    busy: "运行中",
    connecting: "连接中…",
    disconnected: "已断开",
    bridgeFailed: "桥接失败",
    placeholder: "说点什么…  ⌘↵ 发送",
    steer: "插话（steer）",
    send: "发送",
    noConversation: "未选择会话",
    thinking: "思考",
    output: "输出",
    featureReport: "需求报告",
    images: "张图片",
    language: "语言",
    globals: "全局",
    work: "工作",
    chat: "对话",
    feishu: "飞书",
    refresh: "刷新",
    committed: "已提交",
    nothingToCommit: "没有可提交的改动",
    onlyDesktop: "只在桌面客户端里可用",
    clean: "干净",
  },
  en: {
    sessions: "Sessions",
    running: "Running",
    changes: "Changes",
    memory: "Memory",
    noTasks: "No background tasks",
    noMemory: "No memory yet",
    noChanges: "Workspace is clean",
    loadChanges: "Reading changes…",
    commit: "Commit",
    commitPlaceholder: "Commit message",
    truncated: "(diff truncated)",
    untracked: "untracked",
    modified: "modified",
    added: "added",
    deleted: "deleted",
    renamed: "renamed",
    conflicted: "conflicted",
    cumulative: "Total",
    restart: "Restart",
    backup: "Backup",
    logs: "Logs",
    newConv: "/new",
    stop: "/stop",
    idle: "idle",
    busy: "working",
    connecting: "connecting…",
    disconnected: "disconnected",
    bridgeFailed: "bridge failed",
    placeholder: "Say something…  ⌘↵ to send",
    steer: "steer",
    send: "Send",
    noConversation: "No session selected",
    thinking: "Thinking",
    output: "output",
    featureReport: "Feature report",
    images: "images",
    language: "Language",
    globals: "Global",
    work: "Work",
    chat: "Chat",
    feishu: "Feishu",
    refresh: "Refresh",
    committed: "Committed",
    nothingToCommit: "Nothing to commit",
    onlyDesktop: "Desktop app only",
    clean: "clean",
  },
} as const;

export type Key = keyof (typeof dict)["zh"];

const STORAGE_KEY = "agent.lang";

function initialLang(): Lang {
  // `?lang=zh|en` wins: screenshots and demos need a fixed language.
  const forced = new URLSearchParams(location.search).get("lang");
  if (forced === "zh" || forced === "en") return forced;
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

let lang: Lang = initialLang();

export function currentLang(): Lang {
  return lang;
}

export function setLang(next: Lang): void {
  lang = next;
  localStorage.setItem(STORAGE_KEY, next);
  document.documentElement.lang = next === "zh" ? "zh-CN" : "en";
  applyI18n();
}

export function t(key: Key): string {
  return dict[lang][key] ?? dict.zh[key] ?? String(key);
}

/** Replaces every `[data-i18n]` element's text with the current language. */
export function applyI18n(root: ParentNode = document): void {
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n]")) {
    const key = node.dataset["i18n"] as Key | undefined;
    if (key !== undefined) node.textContent = t(key);
  }
  for (const node of root.querySelectorAll<HTMLElement>("[data-i18n-placeholder]")) {
    const key = node.dataset["i18nPlaceholder"] as Key | undefined;
    if (key !== undefined) node.setAttribute("placeholder", t(key));
  }
}

export const statusLabel = (key: string): string => t("status." + key as never) ?? key;

document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
