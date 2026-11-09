/**
 * Two languages, no dependency: a flat dictionary and `tr(lang, key)`.
 * The chosen language lives in the store and is persisted, so every component
 * re-renders through React instead of patching the DOM by hand.
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
    commit: "提交",
    commitMessage: "提交说明",
    truncated: "已截断",
    untracked: "新文件",
    modified: "已修改",
    added: "已新增",
    deleted: "已删除",
    renamed: "已重命名",
    conflicted: "有冲突",
    clean: "无改动",
    cumulative: "累计",
    restart: "重启",
    backup: "备份",
    logs: "日志",
    idle: "空闲",
    busy: "运行中",
    connecting: "连接中…",
    disconnected: "已断开",
    bridgeFailed: "桥接失败",
    placeholder: "说点什么…  ⌘↵ 发送",
    steer: "插话",
    send: "发送",
    noConversation: "未选择会话",
    thinking: "思考",
    output: "输出",
    featureReport: "需求报告",
    images: "张图片",
    globals: "全局",
    work: "工作",
    chat: "对话",
    feishu: "飞书",
    refresh: "刷新",
    committed: "已提交",
    nothingToCommit: "没有可提交的改动",
    onlyDesktop: "只在桌面客户端里可用",
    diffSummary: "个文件",
    language: "语言",
  },
  en: {
    sessions: "Sessions",
    running: "Running",
    changes: "Changes",
    memory: "Memory",
    noTasks: "No background tasks",
    noMemory: "No memory yet",
    noChanges: "Workspace is clean",
    commit: "Commit",
    commitMessage: "Commit message",
    truncated: "truncated",
    untracked: "untracked",
    modified: "modified",
    added: "added",
    deleted: "deleted",
    renamed: "renamed",
    conflicted: "conflicted",
    clean: "clean",
    cumulative: "Total",
    restart: "Restart",
    backup: "Backup",
    logs: "Logs",
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
    globals: "Global",
    work: "Work",
    chat: "Chat",
    feishu: "Feishu",
    refresh: "Refresh",
    committed: "Committed",
    nothingToCommit: "Nothing to commit",
    onlyDesktop: "Desktop app only",
    diffSummary: "files",
    language: "Language",
  },
} as const;

export type Key = keyof (typeof dict)["zh"];

export function tr(lang: Lang, key: Key): string {
  return dict[lang][key] ?? dict.zh[key] ?? String(key);
}

export function initialLang(): Lang {
  const forced = new URLSearchParams(location.search).get("lang");
  if (forced === "zh" || forced === "en") return forced;
  const saved = localStorage.getItem("agent.lang");
  if (saved === "zh" || saved === "en") return saved;
  return navigator.language.toLowerCase().startsWith("zh") ? "zh" : "en";
}

const STATUS_KEYS: Record<string, Key> = {
  modified: "modified",
  added: "added",
  deleted: "deleted",
  renamed: "renamed",
  conflicted: "conflicted",
  untracked: "untracked",
  clean: "clean",
};

export function fileStatusLabel(lang: Lang, status: string): string {
  const key = STATUS_KEYS[status];
  return key === undefined ? status : tr(lang, key);
}
