import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { UsageDoc } from "@earendil-works/pi-durable";
import { config, requireFeishuCredentials, requireFeishuOwner } from "./config.ts";
import { ChatsToken, context, type AgentRuntime } from "./harness.ts";
import { watchLive, type LiveSnapshot } from "./live.ts";
import { setApprovalDecider, setNotifier, type ApprovalRequest } from "./channel.ts";
import { log, logError } from "./log.ts";
import { recent, record } from "./audit.ts";
import { note } from "./notes.ts";
import { lastRequestMessages } from "./context-guard.ts";

/** Above this many request messages a turn starts costing about a minute per step. */
const COMPACT_AFTER_MESSAGES = 400;
import { agentName } from "./identity.ts";
import { SurfaceMetaDoc, updateSurfaceMeta } from "./surface-meta.ts";
import { transcribeAudio } from "./asr.ts";
import {
  attachSubmission,
  clearCardPending,
  type CardPhase,
  leftoverCards,
  markCardPending,
  moveCard,
  noteCardAttempt,
} from "./cards.ts";
import { lookupMessage } from "./threads.ts";
import { readTurnDetails, saveTurnDetails, type TurnDetails } from "./details.ts";
import {
  adoptChatLevels,
  chatAccess,
  chatTopicOf,
  isGuestLevel,
  levelOf,
  ownerChatId,
  rememberOwnerChat,
  setChatLevel,
  setChatTopic,
  setChatTurn,
  setGuestPolicy,
  type ChatLevel,
} from "./access.ts";
import { dropAllApprovals, getApproval, pendingCount, registerApproval, resolveApproval } from "./approvals.ts";
import { addChatNote, chatNotes, clearChatNotes, removeChatNote } from "./memory.ts";

type IncomingMessage = {
  sender?: { sender_id?: { open_id?: string } };
  message?: {
    message_id?: string;
    chat_id?: string;
    chat_type?: string;
    message_type?: string;
    content?: string;
    /** Reply chain: `parent_id` is the answered message, `root_id` the chain start. */
    parent_id?: string;
    root_id?: string;
    /** 话题 groups give every message a thread id. */
    thread_id?: string;
    mentions?: Array<{ key?: string; name?: string; id?: { open_id?: string } }>;
  };
};

type CardAction = {
  operator?: { open_id?: string };
  action?: { value?: Record<string, unknown> };
  context?: { open_message_id?: string; open_chat_id?: string };
};

const MAX_CARD_CHARS = 9_000;
const HELP = [
  "**命令**",
  "- `/new` 换新上下文（历史不删，记忆保留）",
  "- `/stop` 中断当前任务",
  "- `/cost` 今日花费",
  "- `/memory` 看记忆内容",
  "- `/memo` 看本群专属记忆；`/memo add 内容` 添加；`/memo del 3` 删第 3 条；`/memo clear` 清空",
  "- `/project` 看/切换工作仓库（带参数即切换）",
  "- `/id` 当前 chat / conversation / 模型（话题里会显示该话题用的模型）",
  "- `/model` 换本会话模型（卡片按钮）；`/model <id>`、`/model thinking high`、`/model default <id>`",
  "",
  "直接说话就行：能查文件、跑命令、定时提醒、记长期记忆。",
].join("\n");

type CardButton = { label: string; value: Record<string, unknown>; type?: "primary" | "danger" | "default" };

/**
 * A failed turn leaves the card with nothing to press, so the only way on was typing "继续"
 * (from a phone, on a long answer). The button submits a continue for the same conversation.
 * `messageId` is the question the card answered, so a second failure stays pressable.
 */
function continueButton(messageId: string): CardButton[] {
  return [{ label: "继续", value: { kind: "continue", messageId }, type: "primary" }];
}

/**
 * The colour bar is the whole point: a green "答完了", an orange "到了步数上限" and a red
 * "出错了" sit in the same list, and the outcome has to be readable without opening it.
 */
type CardHeader = { template: "green" | "orange" | "grey" | "red" | "blue"; title: string };

/**
 * The band a card wears while the turn runs. A patch replaces the whole card, so every live patch
 * has to carry it again — otherwise the header exists only until the first update 15s later.
 */
const WORKING_HEADER: CardHeader = { template: "blue", title: "⏳ 处理中" };

/** The band on a card that is not the turn's own: a recovered answer arrives as a new message. */
function standaloneHeader(reason: string | undefined): CardHeader {
  return reason === "turn_limit"
    ? { template: "orange", title: `⏸️ 到了 ${config.maxTurns} 步上限` }
    : { template: "grey", title: `⚠️ 这次没答出来 · ${reason ?? "unanswered"}` };
}

/**
 * The steps of a turn as a folded panel in the answer card itself. It used to be a 「查看详情」
 * button — only in 1:1 chats, and it answered with a second card, so a group never saw the work
 * at all and every answer looked like a form to fill in.
 */
function detailPanel(details: Omit<TurnDetails, "at">): Record<string, unknown> {
  const lines = details.steps.map((step, index) => {
    const mark = step.ok ? "✅" : "⚠️";
    return `${index + 1}. ${mark} **${step.name}**\n${step.preview.length > 0 ? `　${step.preview}` : "　（无输出）"}`;
  });
  const summary = `${details.steps.length} 步 · ${details.seconds}s${
    details.costUsd > 0.00005 ? ` · $${details.costUsd.toFixed(4)}` : ""
  }`;
  return {
    tag: "collapsible_panel",
    expanded: false,
    header: {
      title: { tag: "markdown", content: `**本轮执行详情** · ${summary}` },
      vertical_align: "center",
      icon: { tag: "standard_icon", token: "down-small-ccm_outlined", size: "16px 16px" },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "8px",
    padding: "8px 8px 8px 8px",
    elements: [{ tag: "markdown", content: lines.join("\n\n") }],
  };
}

function card(
  markdown: string,
  meta?: string,
  buttons?: CardButton[],
  header?: CardHeader,
  details?: Omit<TurnDetails, "at">,
): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: markdown }];
  if (details !== undefined && details.steps.length > 0) {
    elements.push(detailPanel(details));
  }
  if (meta !== undefined) {
    elements.push({ tag: "note", elements: [{ tag: "plain_text", content: meta }] });
  }
  if (buttons !== undefined && buttons.length > 0) {
    elements.push({
      tag: "action",
      actions: buttons.map((button) => ({
        tag: "button",
        text: { tag: "plain_text", content: button.label },
        type: button.type ?? "default",
        value: button.value,
      })),
    });
  }
  return {
    config: { wide_screen_mode: true, update_multi: true },
    ...(header === undefined
      ? {}
      : { header: { template: header.template, title: { tag: "plain_text", content: header.title } } }),
    elements,
  };
}

function renderDetails(details: TurnDetails): string {
  const lines = details.steps.map((step, index) => {
    const mark = step.ok ? "✅" : "⚠️";
    return `${index + 1}. ${mark} **${step.name}**\n${step.preview.length > 0 ? `　${step.preview}` : "　（无输出）"}`;
  });
  const header = `本轮用了 **${details.steps.length}** 个工具，耗时 **${details.seconds}s**${
    details.costUsd > 0.00005 ? `，花费 **$${details.costUsd.toFixed(4)}**` : ""
  }`;
  return `${header}\n\n${lines.join("\n\n")}`;
}

export function approvalCard(request: ApprovalRequest): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: {
      template: "orange",
      title: { tag: "plain_text", content: "⚠️ 需要你确认" },
    },
    elements: [
      { tag: "markdown", content: `**${request.tool}** — ${request.reason}` },
      { tag: "markdown", content: "```\n" + request.summary.slice(0, 1200) + "\n```" },
      { tag: "note", elements: [{ tag: "plain_text", content: `${Math.round(request.timeoutMs / 1000)}s 内不选则视为拒绝` }] },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "允许" },
            type: "primary",
            value: { approval: request.callId, ok: true },
          },
          // One chat deliberately writing outside the workspace should not raise this
          // card per file: grant the class for the rest of the conversation.
          ...(request.grantKey === undefined
            ? []
            : [
                {
                  tag: "button",
                  text: { tag: "plain_text", content: "本会话内全部允许" },
                  type: "default",
                  value: { approval: request.callId, ok: true, session: true, key: request.grantKey },
                },
              ]),
          {
            tag: "button",
            text: { tag: "plain_text", content: "拒绝" },
            type: "danger",
            value: { approval: request.callId, ok: false },
          },
        ],
      },
    ],
  };
}

/** `HH:MM` in the owner's timezone, for "started at" lines. */
function clock(at: number): string {
  return new Date(at).toLocaleTimeString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
}

/** "3m 12s" — duration as a human reads it. */
function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function clip(text: string): string {
  return text.length <= MAX_CARD_CHARS ? text : `${text.slice(0, MAX_CARD_CHARS)}\n\n…（已截断）`;
}

function renderLive(live: LiveSnapshot): string {
  const body = live.text.trim();
  if (body.length > 0) return clip(body);
  if (live.tools.length > 0) {
    const head = `⚙️ ${live.tools.join(" · ")}`;
    return live.activity === undefined ? head : `${head}\n\n_${live.activity}_`;
  }
  return "🤔 思考中…";
}

type PostElement = { tag?: string; text?: string; image_key?: string };
export type ParsedContent = { text: string; imageKeys: string[]; audioKey?: string };

/** The bot's own open_id, learned at startup, so an @ of itself can be dropped entirely. */
let botOpenId: string | undefined;

/**
 * Feishu renders mentions as "@_user_1" tokens. Addressing the bot is not part of the
 * sentence — leaving "@" behind meant "/help" arrived as "@ /help", so no command ever
 * matched in a group. Mentions of other people keep a readable "@name". Pure, for tests.
 */
export function stripMentionsWith(
  text: string,
  mentions: ReadonlyArray<{ key?: string; name?: string; id?: { open_id?: string } }>,
  bot: string | undefined,
): string {
  let out = text;
  for (const mention of mentions) {
    if (mention.key === undefined) continue;
    const isBot = bot !== undefined && mention.id?.open_id === bot;
    out = out.split(mention.key).join(isBot ? "" : `@${mention.name ?? ""}`);
  }
  return out.trim();
}

function stripMentions(message: NonNullable<IncomingMessage["message"]>, text: string): string {
  return stripMentionsWith(text, message.mentions ?? [], botOpenId);
}

/**
 * Feishu delivers a picture as `image`, but a picture with any text (or a screenshot
 * pasted on mobile) arrives as `post` rich text. Both must be read.
 */
export function parseContent(message: NonNullable<IncomingMessage["message"]>): ParsedContent {
  let body: unknown;
  try {
    body = JSON.parse(message.content ?? "{}");
  } catch {
    return { text: "", imageKeys: [] };
  }

  if (message.message_type === "text") {
    const text = (body as { text?: string }).text ?? "";
    return { text: stripMentions(message, text), imageKeys: [] };
  }
  if (message.message_type === "image") {
    const key = (body as { image_key?: string }).image_key;
    return { text: "", imageKeys: key === undefined ? [] : [key] };
  }
  if (message.message_type === "audio") {
    const key = (body as { file_key?: string }).file_key;
    return { text: "", imageKeys: [], audioKey: key };
  }
  if (message.message_type === "post") {
    const rows = (body as { content?: PostElement[][] }).content ?? [];
    const lines: string[] = [];
    const imageKeys: string[] = [];
    for (const row of rows) {
      const parts: string[] = [];
      for (const element of row) {
        if (element.tag === "text" && typeof element.text === "string") parts.push(element.text);
        else if (element.tag === "a" && typeof element.text === "string") parts.push(element.text);
        else if (element.tag === "img" && typeof element.image_key === "string") imageKeys.push(element.image_key);
      }
      if (parts.length > 0) lines.push(parts.join(""));
    }
    return { text: stripMentions(message, lines.join("\n")), imageKeys };
  }
  return { text: "", imageKeys: [] };
}

/** `/model` forms: list, one id, `default <id>`, `thinking <level>`. */
export type ModelCommand =
  | { kind: "list" }
  | { kind: "set"; modelId: string }
  | { kind: "default"; modelId: string }
  | { kind: "thinking"; level: string };

export function parseModelCommand(raw: string): ModelCommand {
  const arg = raw.trim();
  if (arg.length === 0) return { kind: "list" };
  const [head, ...rest] = arg.split(/\s+/);
  const tail = rest.join(" ").trim();
  if (head === "default" && tail.length > 0) return { kind: "default", modelId: tail };
  if (head === "thinking" && tail.length > 0) return { kind: "thinking", level: tail };
  return { kind: "set", modelId: arg };
}

/** 12.3k / 940: the card line has no room for six digits. */
export function formatTokens(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return "0";
  return tokens >= 1_000 ? `${(tokens / 1000).toFixed(1)}k` : String(Math.round(tokens));
}

/**
 * What a finished turn cost, in one line under the card: tools, tokens, money, model.
 *
 * No duration here: the "答完了" ping right below the card already says how long it took, and the
 * same number twice in two adjacent messages is noise. The start time went with it.
 */
export function turnMeta(input: {
  tools: number;
  tokens: number;
  costUsd: number;
  model: string;
  thinking: string;
}): string {
  const parts = ["✅"];
  if (input.tools > 0) parts.push(`${input.tools} 个工具`);
  if (input.tokens > 0) parts.push(`${formatTokens(input.tokens)} tokens`);
  if (input.costUsd > 0.00005) parts.push(`$${input.costUsd.toFixed(4)}`);
  if (input.model.length > 0) parts.push(input.model);
  if (input.thinking.length > 0) parts.push(`thinking ${input.thinking}`);
  return parts.join(" · ");
}

/** A quoted message, as the model needs it: who wrote it and what it said. */
export type Quoted = { who: string; text: string };

/**
 * Reading a quoted message costs an API round trip, and people quote the same message while
 * answering it. Five minutes is longer than any conversation turn.
 */
const quotedCache = new Map<string, { at: number; value: Quoted | undefined }>();
const QUOTED_TTL_MS = 5 * 60_000;
const QUOTED_CACHE_MAX = 200;

/** The `title` of a merged-forward payload, when there is one. */
function titleOf(content: string): string {
  try {
    const body = JSON.parse(content) as { title?: unknown };
    return typeof body.title === "string" ? body.title.trim().slice(0, 120) : "";
  } catch {
    return "";
  }
}

/** Every `text`/`content` string inside a card JSON, in order — cards are deeply nested. */
function cardText(content: string): string {
  const parts: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 8 || parts.join(" ").length > 1_500) return;
    if (typeof value === "string") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string" && (key === "text" || key === "content" || key === "title")) {
        const trimmed = item.replace(/\s+/g, " ").trim();
        if (trimmed.length > 0) parts.push(trimmed);
        continue;
      }
      walk(item, depth + 1);
    }
  };
  try {
    walk(JSON.parse(content), 0);
  } catch {
    return "";
  }
  return parts.join(" ");
}

/** The text of a quoted message, whatever kind it was: the model can act on words, not ids. */
export function quoteText(
  msgType: string,
  content: string,
  mentions: ReadonlyArray<{ key?: string; name?: string; id?: { open_id?: string } }> = [],
): string {
  if (msgType === "image") return "（一张图片）";
  if (msgType === "audio") return "（一条语音）";
  if (msgType === "file" || msgType === "media") return "（一个文件）";
  if (msgType === "sticker") return "（一个表情）";
  // A merged chat record (会话记录) carries a title and nothing readable: the open API hands out the
  // container, not its messages. Say so with the title, so the answer asks for the few lines that
  // matter instead of guessing from a stale topic.
  if (msgType === "merge_forward") {
    const title = titleOf(content);
    return `（合并转发的聊天记录${title.length > 0 ? `：${title}` : ""}。内容是很多条消息的打包，接口读不到，需要对方把关键几行贴成文字）`;
  }
  if (msgType === "interactive") {
    const own = cardText(content);
    return own.length > 0 ? own.slice(0, 1_200) : "（一张卡片，里面没有可读的文字）";
  }
  const parsed = parseContent({ message_type: msgType, content, mentions } as never);
  const text = parsed.text.replace(/\s+/g, " ").trim();
  if (text.length > 0) return text.slice(0, 1_200);
  if (parsed.imageKeys.length > 0) return `（${parsed.imageKeys.length} 张图片）`;
  return "（没有可读的文字）";
}

/**
 * The message a reply is really pointing at, or "" when there is nothing worth reading.
 *
 * Feishu sets `parent_id` to the topic's root on every message posted inside a topic (44 of 46 in
 * the log here), which is not a quote: that text is already in the fork's history, and re-reading
 * it would paste the same paragraph in front of every turn. A quote is a parent that is not the
 * topic root, or any parent of a message outside a topic.
 */
export function quotedParentId(message: {
  parent_id?: string;
  root_id?: string;
  thread_id?: string;
  message_id?: string;
}): string {
  const parent = message.parent_id ?? "";
  if (parent.length === 0 || parent === message.message_id) return "";
  const inTopic = (message.thread_id ?? "").length > 0;
  if (inTopic && parent === (message.root_id ?? "")) return "";
  return parent;
}

/** The block the model sees in front of the reply, so "这个" has something to point at. */
export function quoteBlock(quoted: Quoted): string {
  return `[引用 · ${quoted.who} 的消息]\n${quoted.text}\n[引用结束]\n\n`;
}

/**
 * Only the owner may authorize a chat, authorize a person, or answer an approval.
 * An empty allowlist is a misconfiguration, so it trusts nobody: the bridge refuses to start
 * without one, and this stays safe if that check is ever bypassed.
 */
export function isOwnerOperator(openId: string, owners: readonly string[] = config.feishu.allowedSenderIds): boolean {
  return owners.length > 0 && openId.length > 0 && owners.includes(openId);
}

/** The gate in front of every inbound message; explicit for tests, config by default. */
export type Gate = {
  mentionsOnly: boolean;
};

/**
 * Every group turn carries who is speaking, in the message itself. A claim in the instructions
 * ("this turn is the owner") does not survive a transcript of earlier refusals: the model
 * answers "I cannot verify your identity". A bracketed speaker on each message is evidence it
 * can read, turn by turn.
 */
export function speakerTag(isOwner: boolean, senderId: string): string {
  return isOwner ? `[alex 本人 ${senderId.slice(0, 8)}]` : `[群成员 ${senderId.slice(0, 8)}]`;
}

/** What a refusal to write looks like, in the forms this agent actually produced. */
export function looksLikeReadOnlyRefusal(answer: string): boolean {
  // A real approval card ("命令被拦下来等你确认") is not a false refusal: the tool IS blocked,
  // just for a reason the correction would contradict.
  if (/审批|批准|确认卡|等你确认|稍后确认/.test(answer)) return false;
  return /只读|权限.{0,6}(关|没|被)|会话初始化|guest ?模式.{0,8}(禁|不|没|拦|只)|拦着|拦下|被拦|无法(执行|运行|改|写)|bash.{0,12}(用不|不能|被禁)|没法直接(改|写|提交|推)|不能直接(改|写|提交|推)|粘贴到终端|粘一下|用一行 ?(sed|命令)|你自己(执行|跑|粘|来)/.test(
    answer,
  );
}

/** Appended as a fresh user turn after a false read-only refusal; the last word in context. */
export const READ_ONLY_CORRECTION =
  "（网关）你刚才那条回答作废：本轮提问的是 alex 本人（已校验），这个群现在的写权限是开的。" +
  "write/edit/bash 对你都可用，改文件、推分支、触发部署都不会被拦（危险命令照旧弹审批）。" +
  "直接执行他要的修改，不要再解释权限、不要再让他去粘命令或换私聊。";

/**
 * What a shared group is told. The memory rule is the same for everyone — a group conversation
 * never sees the owner's memory. Who may change files is decided per turn: the owner asking in
 * his own group is still the owner, and refusing him made /allow useless for real work.
 */
export function groupInstructions(who: "owner" | "guest", topic?: string): string {
  const lines = [
    "这是一个共享群（群里有其他人）。",
    "- 不要透露 alex 的个人信息、记忆、日程、其他会话内容。",
    "- 每条消息开头的方括号是网关标注的说话人：「alex 本人」就是 Alex 本人的账号，已经校验过，不需要你再判断身份；「群成员」不是。",
    who === "owner"
      ? "- 本轮是 alex 本人提问：按他说的改文件、跑命令、推分支、触发部署都可以。"
      : "- 本轮不是 alex：只读查证照常做（read / project_search / logs_query / bash 的只读命令：git log、grep、psql select 都放行，所有已注册项目都能读）。不要改文件、不要推分支、不要触发部署、不要写记忆；被拦时只说被拦的那条命令，不要笼统说「guest 模式用不了工具」。",
  ];
  if (who === "owner") {
    // The model reads its own earlier refusals in the transcript and repeats them, even when
    // the rule under them has changed. Say the old rule is dead instead of hoping.
    lines.push(
      "- 工具面按说话人切换：guest 模式只管别人的回合。你自己的回合里 bash / write / edit / lark / mcp / delegate 全都能用。",
      "- 旧规则已作废：本群以前确实被设成只读，那条不再适用。不要再回答「这轮是只读的」或「bash 在这个群里用不了」，" +
        "也不要让 alex 自己去粘命令或开新会话。",
    );
  }
  if (topic !== undefined) lines.push(`- ${topic}`);
  return lines.join("\n");
}

export function rejectionReason(
  event: IncomingMessage,
  parsedContent: ParsedContent,
  level: ChatLevel = "closed",
  isOwner = false,
  policy: Gate = config.feishu,
): string | undefined {
  const message = event.message;
  const content = parsedContent;
  const supported =
    message?.message_type === "text" ||
    message?.message_type === "image" ||
    message?.message_type === "post" ||
    message?.message_type === "audio";
  if (!supported) return `unsupported-message-type:${message?.message_type ?? "?"}`;
  if (content.text.length === 0 && content.imageKeys.length === 0 && content.audioKey === undefined) {
    return "empty-content";
  }
  // One level decides everything: closed answers nobody, owner only the owner, group everyone
  // (with the guest surface for whoever is not the owner).
  if (level === "closed") return "chat-not-allowed";
  if (level === "owner" && !isOwner) return "owner-only";
  if (policy.mentionsOnly && message?.chat_type === "group" && (message.mentions ?? []).length === 0) {
    return "group-message-without-mention";
  }
  return undefined;
}

/**
 * Answers belong in a topic: an @ in a group is a person asking one question, and the
 * answer should not push the conversation aside for everyone else. A plain message in a
 * group (only possible once the app may read all group messages) still answers inline.
 * Feishu collapses thread replies behind "N 条回复", which is the trade-off the owner
 * asked for; "always"/"never" override the whole rule.
 */
export function wantsThread(
  message: NonNullable<IncomingMessage["message"]>,
  topicGroup = false,
): boolean {
  const mode = config.feishu.replyInThread;
  if (message.chat_type !== "group" || mode === "never") return false;
  if (mode === "always" || topicGroup) return true;
  const alreadyInThread = message.thread_id !== undefined && message.thread_id !== message.message_id;
  const addressed = (message.mentions ?? []).length > 0;
  return alreadyInThread || addressed;
}

function mentionFor(
  event: IncomingMessage,
  message: NonNullable<IncomingMessage["message"]>,
): string | undefined {
  if (message.chat_type !== "group" || !config.feishu.mentionSender) return undefined;
  return event.sender?.sender_id?.open_id ?? undefined;
}

/** Liveness of the long connection, so a deaf bot is visible instead of silent. */
export type FeishuStatus = {
  ready: boolean;
  /** Epoch ms of the last successful connect (or of process start). */
  since: number;
  /** Connect failures since start; a flapping link drops events while it is down. */
  flaps: number;
  lastError?: string;
};

const feishuStatus: FeishuStatus = { ready: false, since: Date.now(), flaps: 0 };
let feishuStarted = false;

/** Snapshot for the client: how long the bot has been deaf, in ms (0 while connected). */
export const getFeishuStatus = (): FeishuStatus & { started: boolean; downMs: number } => ({
  ...feishuStatus,
  started: feishuStarted,
  downMs: feishuStatus.ready ? 0 : Date.now() - feishuStatus.since,
});

export type FeishuBridge = { stop(): void };

export async function startFeishuBridge(runtime: AgentRuntime): Promise<FeishuBridge> {
  const { appId, appSecret } = requireFeishuCredentials();
  // Also here, not only at the entry point: a bridge without an owner answers nobody and would
  // authorize anybody, which is worse than not starting.
  requireFeishuOwner();
  feishuStarted = true;
  // One-time adoption: chats from `.env`, and chats the previous model stored in its two docs.
  // Until this runs, `.env` is the only source, so a fresh process still answers its own chats.
  await adoptChatLevels(runtime.harness, context, config.feishu.allowedChatIds);
  const client = new Lark.Client({ appId, appSecret });

  // Who we are, so an @ of the bot can be dropped from the text instead of leaving "@".
  await client
    .request({ method: "GET", url: "/open-apis/bot/v3/info" })
    .then((response: { bot?: { open_id?: string } }) => {
      botOpenId = response?.bot?.open_id;
      log("feishu", "bot identity", { openId: botOpenId ?? "unknown" });
    })
    .catch((error: unknown) => logError("feishu", "could not read bot identity", error));

  const handled = new Set<string>();

  async function sendText(chatId: string, text: string): Promise<void> {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }

  /**
   * A message for a turn that may be over: reply to what was asked, inside its topic when it had one.
   * Posting to the chat instead put a recovered answer outside the topic, and as a second copy of an
   * answer the live turn had already delivered.
   */
  /** Replies with a card, not text: a recovered answer carries markdown, and as plain text the
   * `**bold**` and `| tables |` arrived unrendered. */
  async function replyOrSend(
    chatId: string,
    messageId: string | undefined,
    thread: boolean | undefined,
    markdown: string,
    meta?: string,
    header?: CardHeader,
  ): Promise<void> {
    if (messageId === undefined) {
      await sendText(chatId, markdown);
      return;
    }
    await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card(markdown, meta, undefined, header)),
        ...(thread === true ? { reply_in_thread: true } : {}),
      },
    });
  }

  async function patchCard(
    messageId: string,
    markdown: string,
    meta?: string,
    buttons?: CardButton[],
    header?: CardHeader,
    details?: Omit<TurnDetails, "at">,
  ): Promise<void> {
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card(markdown, meta, buttons, header, details)) },
    });
    if (response?.code !== 0) {
      throw new Error(`patch failed: ${response?.code} ${response?.msg ?? ""}`);
    }
  }

  /**
   * Final answer delivery: patch the streaming card, and if that fails for any
   * reason send the answer as a plain message so it is never lost behind a
   * stranded "thinking" card.
   */
  /**
   * A card patch raises no Feishu notification: someone who read "处理中" and put the
   * phone down would never learn the run finished. One short message does.
   */
  async function pingDone(
    chatId: string,
    messageId: string,
    markdown: string,
    options: { thread?: boolean },
  ): Promise<void> {
    try {
      await client.im.message.reply({
        path: { message_id: messageId },
        data: {
          msg_type: "text",
          content: JSON.stringify({ text: markdown }),
          ...(options.thread === true ? { reply_in_thread: true } : {}),
        },
      });
      log("feishu", "done ping sent", { chatId, chars: markdown.length });
    } catch (error) {
      logError("feishu", "could not send done ping", error);
    }
  }

  async function deliverAnswer(
    chatId: string,
    cardId: string,
    markdown: string,
    meta: string,
    buttons?: CardButton[],
    header?: CardHeader,
    details?: Omit<TurnDetails, "at">,
  ): Promise<void> {
    try {
      await patchCard(cardId, markdown, meta, buttons, header, details);
      log("feishu", "final card patched", { chatId, cardId, chars: markdown.length });
      return;
    } catch (error) {
      logError("feishu", "final card patch failed, falling back to text", error);
    }
    try {
      await sendText(chatId, markdown);
      log("feishu", "answer sent as plain text fallback");
    } catch (error) {
      logError("feishu", "plain text fallback failed", error);
    }
  }

  async function replyCard(
    messageId: string,
    markdown: string,
    meta?: string,
    options: { thread?: boolean; mention?: string; buttons?: CardButton[]; header?: CardHeader } = {},
  ): Promise<string | undefined> {
    const body = options.mention === undefined ? markdown : `<at id=${options.mention}></at> ${markdown}`;
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: {
        msg_type: "interactive",
        content: JSON.stringify(card(body, meta ?? "▶️ 处理中", options.buttons, options.header)),
        // Group replies stay in one thread: the timeline stays readable and the
        // thread itself becomes the conversation (our fork logic keys on thread_id).
        ...(options.thread === true ? { reply_in_thread: true } : {}),
      },
    });
    return response?.data?.message_id;
  }

  async function downloadResource(
    messageId: string,
    fileKey: string,
    type: "image" | "file",
  ): Promise<Buffer | undefined> {
    try {
      const resource = (await client.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type },
      })) as unknown as {
        writeFile?: (path: string) => Promise<void>;
        getReadableStream?: () => NodeJS.ReadableStream;
      };
      if (typeof resource?.writeFile === "function") {
        const file = join(tmpdir(), `feishu-${fileKey}`);
        await resource.writeFile(file);
        const bytes = await readFile(file);
        await rm(file, { force: true });
        return bytes;
      }
      if (typeof resource?.getReadableStream === "function") {
        const chunks: Buffer[] = [];
        for await (const chunk of resource.getReadableStream()) chunks.push(Buffer.from(chunk as Buffer));
        return Buffer.concat(chunks);
      }
      logError("feishu", "unexpected resource shape", Object.keys(resource ?? {}).join(","));
    } catch (error) {
      logError("feishu", `resource download failed (${type})`, error);
    }
    return undefined;
  }

  async function downloadImage(
    messageId: string,
    fileKey: string,
  ): Promise<{ data: string; mimeType: string } | undefined> {
    const bytes = await downloadResource(messageId, fileKey, "image");
    if (bytes === undefined) return undefined;
    return { data: bytes.toString("base64"), mimeType: sniff(bytes) };
  }

  // The extensions reach back through these two hooks.
  setNotifier(async (surfaceId, text) => {
    // Only a Feishu chat can receive a message here; other surfaces (cli, client) are
    // handled by their own notifier, and asking Feishu for one returns 230001.
    if (!surfaceId.startsWith("oc_") && !surfaceId.startsWith("on_")) {
      log("feishu", "notifier skipped a surface that is not a chat", { surfaceId });
      return;
    }
    await sendText(surfaceId, text);
  });
  setApprovalDecider(async (request) => {
    // The owner answers in their own DM. A card in the group would show everyone what is about
    // to be deleted, and a group member could not answer it anyway.
    const ownerChat = await ownerChatId(runtime.harness, context).catch(() => undefined);
    const target = ownerChat ?? request.surfaceId;
    const sent = target.startsWith("oc_")
      ? await client.im.message
          .create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: target,
              msg_type: "interactive",
              content: JSON.stringify(approvalCard(request)),
            },
          })
          // A surface that is not a Feishu chat (cli, client) gets no card: the
          // approval still shows up in the registry for the client to answer.
          .catch((error) => {
            logError("feishu", "could not send approval card", error);
            return undefined;
          })
      : undefined;
    if (ownerChat === undefined) {
      // The owner's DM is learned from their first message; until then the card has to go where
      // the call came from, and the owner needs to know how to fix that.
      await sendText(
        request.surfaceId,
        `⚠️ 需要 alex 确认才能继续（${request.tool}）。我还没记住 alex 的私聊会话：请 alex 在私聊里给我发一句任何话。`,
      ).catch(() => {});
    }
    const cardId = sent?.data?.message_id;
    log("feishu", "approval card sent", { cardId, callId: request.callId.slice(-12), tool: request.tool });
    return new Promise<boolean>((resolve) => {
      // The registry owns the pending state and the timeout; this surface only says what its card
      // should look like once the decision lands, whoever made it. Keeping a second map here is
      // what let "still pending" be true in one place and false in the other.
      registerApproval({
        callId: request.callId,
        conversationId: request.conversationId,
        grantKey: request.grantKey,
        tool: request.tool,
        summary: request.summary,
        reason: request.reason,
        surfaceId: request.surfaceId,
        timeoutMs: request.timeoutMs,
        onSettled: ({ approved, by }) => {
          if (cardId === undefined) return;
          const text =
            by === "timeout"
              ? `⏹️ 超时未确认，已拒绝：${request.tool}`
              : approved
                ? `✅ 已允许（${by === "client" ? "客户端" : "飞书"}确认），继续执行`
                : `🛑 已拒绝（${by === "client" ? "客户端" : "飞书"}）`;
          void patchCard(cardId, text, by === "timeout" ? undefined : `${by === "client" ? "桌面客户端" : "飞书"}确认`).catch(
            (error) => logError("feishu", "could not patch approval card", error),
          );
        },
        resolve: (approved) => resolve(approved),
      });
    });
  });

/** Cards with a continue already running, so a double tap cannot start two turns at once. */
const continuing = new Set<string>();

  /**
   * The 「继续」 button under a card that did not finish. Submitted with no new user message, so it
   * replays the same context, and the answer lands in the card that asked for it: the turn reads as
   * one answer instead of a second card after the first.
   */
  async function continueFromCard(chatId: string, cardId: string, messageId: string): Promise<void> {
    if (continuing.has(cardId)) return;
    continuing.add(cardId);
    const startedAt = Date.now();
    try {
      // The index knows which conversation answered this message; a topic's fork is not the chat's
      // own conversation, so a missing entry is the only case that falls back to the chat.
      const hit = await lookupMessage(runtime.harness, context, messageId).catch(() => undefined);
      const indexed =
        hit === undefined ? undefined : await runtime.harness.conversation(hit.conversationId as never, context);
      const conversation = indexed ?? (await runtime.conversationFor(chatId));
      await patchCard(cardId, "▶️ 继续中…", "从卡片继续这一轮", undefined, WORKING_HEADER).catch(() => {});
      const submission = await conversation.submit(
        { type: "continue", requestId: `continue-card:${cardId}:${startedAt}` },
        context,
      );
      const settled = await submission.wait(context);
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      log("feishu", "card continue settled", { status: settled.status, seconds });
      if (settled.status === "done" && settled.answer !== undefined) {
        const answer = await runtime.answerText(conversation, settled.answer);
        await deliverAnswer(chatId, cardId, answer || "（模型没有返回文本）", `✅ 接着答完了 · ${seconds}s`, undefined, {
          template: "green",
          title: "✅ 答完了",
        });
      } else {
        await deliverAnswer(
          chatId,
          cardId,
          `⚠️ 接着跑也没收尾：${settled.reason ?? "unanswered"}`,
          `⏸️ ${seconds}s`,
          continueButton(messageId),
          { template: "orange", title: "⏸️ 还是没收尾" },
        );
      }
      if (seconds >= config.feishu.donePingSeconds) {
        await pingDone(chatId, cardId, `✅ 接着答完了 · ${seconds}s`, {
          thread: topicChats.get(chatId) === true,
        });
      }
    } catch (error) {
      logError("feishu", "card continue failed", error);
      await deliverAnswer(
        chatId,
        cardId,
        `❌ 继续失败：${(error as Error).message}`,
        "⏹️ 失败",
        continueButton(messageId),
        { template: "red", title: "❌ 出错了" },
      );
    } finally {
      continuing.delete(cardId);
    }
  }

  async function handleCardAction(payload: CardAction): Promise<Record<string, unknown>> {
    const receivedAt = Date.now();
    const value = payload.action?.value ?? {};

    if (value["kind"] === "set-model") {
      const operator = payload.operator?.open_id ?? "";
      if (!isOwnerOperator(operator)) return { toast: { type: "warning", content: "只有 alex 能换模型" } };
      const target = Number(value["conversationId"]);
      const provider = typeof value["provider"] === "string" ? value["provider"] : "magpie";
      const modelId = typeof value["modelId"] === "string" ? value["modelId"] : "";
      if (!Number.isFinite(target) || modelId.length === 0) return { toast: { type: "error", content: "缺少模型或会话" } };
      const conversation = await runtime.harness
        .conversation(target as never, context)
        .catch(() => undefined);
      if (conversation === undefined) return { toast: { type: "error", content: "会话不在了" } };
      await runtime.setModel(conversation, { provider, modelId });
      log("feishu", "model switched from a card", { conversationId: target, modelId });
      return { toast: { type: "success", content: `已切到 ${modelId}（下一轮生效）` } };
    }

    if (value["kind"] === "open-chat") {
      const operator = payload.operator?.open_id ?? "";
      if (!isOwnerOperator(operator)) {
        return { toast: { type: "warning", content: "只有 alex 可以授权" } };
      }
      const chatId = typeof value["chatId"] === "string" ? value["chatId"] : "";
      if (chatId.length === 0) return { toast: { type: "error", content: "缺少会话 id" } };
      // One button, one level: the person or the group gets guest access, and the guest policy
      // keeps the owner's memory out of it. It used to take two cards to reach this point.
      await setChatLevel(runtime.harness, context, chatId, "group");
      const conversation = await runtime.conversationFor(chatId);
      await setGuestPolicy(runtime.harness, context, conversation.id as unknown as number).catch(() => {});
      // A shared group does not need the owner's 16k of headroom: compacting earlier keeps every
      // group turn cheaper, and the transcript it summarizes is public to the group anyway.
      await conversation
        .configure({ compaction: { reserveTokens: 8_192 } }, context)
        .catch((error: unknown) => logError("feishu", "could not set group compaction", error));
      void sendText(chatId, "已开通（guest 权限）：可以问我了。我看不到 alex 的私人记忆，也不会改动文件。").catch(
        () => {},
      );
      const messageId = payload.context?.open_message_id;
      if (messageId !== undefined) {
        void patchCard(messageId, `✅ 已开放 ${chatId.slice(-6)}`, "guest 权限：只读工具、不写记忆").catch(() => {});
      }
      return { toast: { type: "success", content: "已开放，并通知了对方" } };
    }

    if (value["kind"] === "continue") {
      const messageId = typeof value["messageId"] === "string" ? value["messageId"] : "";
      const chatId = payload.context?.open_chat_id ?? "";
      const cardId = payload.context?.open_message_id ?? "";
      if (chatId.length === 0 || cardId.length === 0) {
        return { toast: { type: "error", content: "缺少会话信息" } };
      }
      // A continue runs for minutes and Feishu drops a callback after ~3s: answer now, work later.
      void continueFromCard(chatId, cardId, messageId);
      return { toast: { type: "success", content: "继续中…" } };
    }

    // Answers now carry the panel themselves; this only serves buttons on cards sent before that.
    if (value["kind"] === "detail") {
      const messageId = typeof value["messageId"] === "string" ? value["messageId"] : "";
      const chatId = payload.context?.open_chat_id ?? "";
      const details = await readTurnDetails(runtime.harness, context, messageId);
      if (details === undefined) return { toast: { type: "info", content: "这轮没有工具调用记录" } };
      if (chatId.length > 0) {
        // Fire and forget: the callback response has a ~3s budget.
        void client.im.message
          .create({
            params: { receive_id_type: "chat_id" },
            data: {
              receive_id: chatId,
              msg_type: "interactive",
              content: JSON.stringify(card(renderDetails(details), "🔍 本轮执行详情")),
            },
          })
          .catch((error) => logError("feishu", "could not send detail card", error));
      }
      return { toast: { type: "success", content: "详情已发送" } };
    }

    const callId = typeof value["approval"] === "string" ? value["approval"] : "";
    const operator = payload.operator?.open_id ?? "";
    const entry = getApproval(callId);
    log("feishu", "card action received", {
      callId: callId.slice(-12),
      operator: operator.slice(-6),
      ok: value["ok"],
      pending: entry !== undefined,
      pendingIds: pendingCount(),
      messageId: payload.context?.open_message_id,
    });
    if (entry === undefined) return { toast: { type: "info", content: "已处理" } };

    if (!isOwnerOperator(operator)) return { toast: { type: "warning", content: "只有 alex 可以确认" } };

    const approved = value["ok"] === true;
    if (approved && value["session"] === true && typeof value["key"] === "string" && entry.conversationId !== undefined) {
      void runtime.grantSession(entry.conversationId, value["key"]).catch((error) =>
        logError("feishu", "could not store session grant", error),
      );
    }
    // The registry decides and tells every surface — this card included, through onSettled. A false
    // therefore means another surface answered in between: this click was simply late.
    if (!resolveApproval(callId, approved, `feishu:${operator.slice(-6)}`)) {
      return { toast: { type: "info", content: "已经处理过了" } };
    }
    log("feishu", "approval answered", { approved, callId: callId.slice(-12), ms: Date.now() - receivedAt });
    void record(runtime.harness, context, {
      kind: "approve",
      who: operator.slice(-6),
      tool: entry.tool,
      chat: entry.surfaceId,
      detail: approved ? "approved" : "denied",
    });
    return { toast: { type: "success", content: approved ? "已允许，继续执行" : "已拒绝" } };
  }

  /**
   * Someone the bot has never met is talking to it. Silence would look like a broken bot, so
   * the owner gets one card with one button: open this chat with guest access.
   */
  async function notifyOwnerOfStranger(
    event: IncomingMessage,
    message: NonNullable<IncomingMessage["message"]>,
    text: string,
  ): Promise<void> {
    const ownerChat = await ownerChatId(runtime.harness, context).catch(() => undefined);
    if (ownerChat === undefined) return;
    const senderId = event.sender?.sender_id?.open_id ?? "?";
    const where = message.chat_type === "p2p" ? "私聊" : "群聊";
    const headline = message.chat_type === "p2p" ? "有人私聊 bot" : "有未授权的群在 @ bot";
    const body = text.replace(/[\n`]/g, " ").slice(0, 200);
    const cardBody =
      `**${headline}**\n` +
      `- 来源：${where}\n` +
      `- 会话：\`${message.chat_id}\`\n` +
      `- 发送者：\`${senderId}\`\n` +
      `- 内容：${body.length > 0 ? body : "（非文字消息）"}\n`;
    const buttons = [
      { label: "开放此会话（guest 权限）", value: { kind: "open-chat", chatId: message.chat_id }, type: "primary" as const },
    ];
    try {
      await client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: {
          receive_id: ownerChat,
          msg_type: "interactive",
          content: JSON.stringify(card(cardBody, "对方没有收到回复", buttons)),
        },
      });
      log("feishu", "stranger reported to owner", { chat: message.chat_id, chatType: message.chat_type });
      void record(runtime.harness, context, {
        kind: "report",
        who: senderId.slice(-6),
        chat: message.chat_id,
        detail: message.chat_type === "p2p" ? "p2p stranger" : "unopened group",
      });
    } catch (error) {
      logError("feishu", "could not report stranger to owner", error);
    }
  }

  /** Every step a shared group needs: remember it is open, and give its conversation the rules. */
  async function openGroup(chatId: string, instructions: string): Promise<void> {
    // One level replaces the old pair of lists: the chat is a group, which is also what the gate,
    // the guest policy and the tool surface read.
    await setChatLevel(runtime.harness, context, chatId, "group");
    const conv = await runtime.conversationFor(chatId);
    await setGuestPolicy(runtime.harness, context, conv.id as unknown as number);
    await conv.configure({ instructions }, context);
    log("feishu", "group opened as guest chat", { chatId });
  }

  /** Replies in a topic group belong inside the topic, whoever started it. */
  const threadFor = (message: NonNullable<IncomingMessage["message"]>): boolean =>
    wantsThread(message, topicChats.get(message.chat_id ?? "") === true);

  async function handle(event: IncomingMessage): Promise<void> {
    const message = event.message;
    if (message?.message_id === undefined || message.chat_id === undefined) return;
    const parsed = parseContent(message);
    const text = parsed.text;
    const owner = config.feishu.allowedSenderIds;
    const senderId = event.sender?.sender_id?.open_id ?? "";
    // The bridge refuses to start without an owner, so an empty list here means nobody is one.
    const isOwner = owner.length > 0 && owner.includes(senderId);
    const access = await chatAccess(runtime.harness, context).catch(() => ({}) as Record<string, ChatLevel>);
    const level = levelOf(message.chat_id, access, config.feishu.allowedChatIds);
    // A group's own name belongs in the rail; the event never carries it, so ask once.
    if (level !== "closed" && message.chat_id.startsWith("oc_")) {
      // Awaited: whether this is a topic group decides where the answer goes, and the lookup is
      // cached after the chat's first message.
      await rememberChatInfo(message.chat_id).catch(() => {});
    }
    const isGuestChat = isGuestLevel(level);
    const reason = rejectionReason(event, parsed, level, isOwner);
    // Where to send "someone is asking" — the stranger's chat cannot be the address. The owner's
    // own DM is level owner from its first message, so a card always has somewhere to go.
    if (isOwner && message.chat_type === "p2p") {
      void rememberOwnerChat(runtime.harness, context, message.chat_id).catch(() => {});
      if (level !== "owner") {
        void setChatLevel(runtime.harness, context, message.chat_id, "owner").catch(() => {});
      }
    }
    // A chat the bot has never been opened in gets one card to the owner, with one button.
    if (level === "closed" && !isOwner) {
      await notifyOwnerOfStranger(event, message, text);
    }
    // A chat pinned to the owner: say so once, instead of carding every message.
    if (reason === "owner-only") {
      await sendText(message.chat_id, "这个会话只对 alex 开放。发一句 /allow 可以让这里所有人都能用。").catch(
        () => {},
      );
    }

    // Self-service onboarding: the owner authorizes a new group from the group. A group is
    // shared, so /allow opens it as a guest chat in one step — its members then need no
    // per-person card, and none of them sees the owner's memory.
    if (text.trim() === "/allow" && isOwner) {
      if (message.chat_type === "p2p") {
        // A p2p chat has exactly one other person in it, so opening it opens it to them.
        await setChatLevel(runtime.harness, context, message.chat_id, "owner");
        await sendText(message.chat_id, "已把本会话加入白名单。");
        return;
      }
      await openGroup(message.chat_id, groupInstructions("guest"));
      await sendText(
        message.chat_id,
        "已把本群开放给所有人（guest 模式）：群里谁 @我 都能用；看不到你的个人记忆。你自己问的时候照常能改文件、推分支。",
      );
      return;
    }
    if (text.trim() === "/allow") {
      // Only the owner authorizes a chat; a closed group is told why, an open one stays quiet.
      if (reason !== undefined) await sendText(message.chat_id, "只有 alex 能授权本群。").catch(() => {});
      return;
    }
    if (text.trim() === "/close" && isOwner) {
      // The level goes back to closed, so an opened group can be shut without editing .env.
      await setChatLevel(runtime.harness, context, message.chat_id, "closed");
      await sendText(message.chat_id, "已关闭本群的访问：之后这里 @我 不会有回应。再发 /allow 可以重新开放。");
      return;
    }
    if (text.trim() === "/open" && isOwner) {
      const topic = "只回答与本群主题相关的问题（Android 客户端）。";
      const conversation = await runtime.conversationFor(message.chat_id);
      await setChatTopic(runtime.harness, context, conversation.id as unknown as number, topic);
      await openGroup(message.chat_id, groupInstructions("guest", topic));
      await sendText(message.chat_id, "已把本群开放给所有成员（guest 模式）：共享群只答本群主题，不会透露 alex 的信息。");
      return;
    }
    if (isGuestChat && !isOwner) {
      log("feishu", "guest turn", { chatId: message.chat_id, sender: senderId.slice(-6) });
    }
    if (reason === "chat-not-allowed" && isOwner) {
      // Log the text: if /allow did not match, seeing what arrived is the whole diagnosis.
      console.log(
        `[feishu] unknown chat ${message.chat_id}, asking owner to authorize text=${JSON.stringify(text.slice(0, 40))} type=${message.message_type}`,
      );
      await sendText(
        message.chat_id,
        `这个群还没授权（${message.chat_id}）。\n发 /allow 授权本群，或把它加进 .env 的 FEISHU_ALLOWED_CHAT_IDS。`,
      ).catch(() => {});
      return;
    }
    const summary = `chat=${message.chat_id} chat_type=${message.chat_type ?? "?"} sender=${
      event.sender?.sender_id?.open_id ?? "?"
    }`;
    if (reason !== undefined) {
      log("feishu", `ignored (${reason})`, summary);
      return;
    }
    console.log(
      `[feishu] accepted ${summary} msg=${message.message_id} type=${message.message_type} images=${
        parsed.imageKeys.length
      } thread=${message.thread_id ?? "-"} root=${message.root_id ?? "-"} parent=${message.parent_id ?? "-"} text=${JSON.stringify(
        text.slice(0, 60),
      )}`,
    );
    if (handled.has(message.message_id)) {
      console.log(`[feishu] duplicate delivery msg=${message.message_id}, ignored`);
      return;
    }
    handled.add(message.message_id);
    if (handled.size > 1_000) handled.delete(handled.values().next().value as string);

    const chatId = message.chat_id;
    const startedAt = Date.now();
    /** Seconds since the turn started, for progress lines. */
    const elapsed = (): string => `${Math.round((Date.now() - startedAt) / 1000)}s`;
    // A reply or a 话题 message gets its own conversation forked at the message it
    // answers; everything else shares the chat conversation.
    const rawThreadKey = message.thread_id ?? message.root_id ?? message.parent_id;
    const threadKey = rawThreadKey === message.message_id ? undefined : rawThreadKey;
    const parentMessageId = message.parent_id ?? message.root_id;
    const conversation =
      threadKey === undefined
        ? await runtime.conversationFor(chatId)
        : await runtime.conversationForThread(chatId, { threadKey, parentMessageId });
    if (isGuestChat) {
      // Memory stays off for the whole conversation (a group is shared), but the write rule is
      // per turn: the owner asking in his own group is still the owner. This also replaces the
      // old "heal an opened chat" step: every turn reapplies the policy, so there is nothing
      // stale to repair.
      const topic = await chatTopicOf(runtime.harness, context, conversation.id as unknown as number).catch(
        () => undefined,
      );
      await setGuestPolicy(runtime.harness, context, conversation.id as unknown as number).catch(() => {});
      // A shared group does not need the owner's 16k of headroom: compacting earlier keeps every
      // group turn cheaper, and the transcript it summarizes is public to the group anyway.
      await conversation
        .configure({ compaction: { reserveTokens: 8_192 } }, context)
        .catch((error: unknown) => logError("feishu", "could not set group compaction", error));
      await conversation
        .configure({ instructions: groupInstructions(isOwner ? "owner" : "guest", topic) }, context)
        .catch((error: unknown) => logError("feishu", "could not set group instructions", error));
      // The guard hook reads this to pick the tool surface; a prompt alone cannot keep a group
      // member out of `cat .env`.
      await setChatTurn(runtime.harness, context, conversation.id as unknown as number, isOwner ? "owner" : "guest").catch(
        (error: unknown) => logError("feishu", "could not mark the turn", error),
      );
    }
    // A conversation remembers the turn limit it was created with, so a raised default never
    // reached the chats that already exist. This is a Feishu-driven conversation, its limit is
    // the global one, not a subagent role's.
    await conversation
      .configure({ maxTurns: config.maxTurns }, context)
      .catch((error: unknown) => logError("feishu", "could not set the turn limit", error));
    // Commands must survive a mention that could not be resolved to the bot: "@agent /stop"
    // and a leftover "@ /stop" both have to reach the /stop branch.
    const command = text.trim().replace(/^@\S*\s*/, "");

    if (/^\/(help|帮助)$/i.test(command)) {
      await replyCard(message.message_id, HELP, "💡 命令一览", {
        thread: threadFor(message),
        mention: mentionFor(event, message),
      });
      return;
    }
    // `/new 交接内容` starts the new context with that line as its user message, so the next turn
    // picks up where the old one left off instead of starting blank.
    const resetMatch = /^\/(?:new|reset|新会话|清空)(?:\s+([\s\S]*))?$/i.exec(command);
    if (resetMatch !== null) {
      const handoff = (resetMatch[1] ?? "").trim();
      await conversation.reset(handoff.length === 0 ? undefined : handoff, context);
      await sendText(
        chatId,
        handoff.length === 0
          ? "已开新会话。历史还在存储里，长期记忆也保留。"
          : `已开新会话，交接：「${handoff.slice(0, 80)}${handoff.length > 80 ? "…" : ""}」。下一句话我接着这个做。`,
      );
      return;
    }
    if (/^\/(compact|压缩)$/i.test(command) && isOwner) {
      // A durable task: it may take a while, so the card is not held open for it.
      const started = await conversation.compact(undefined, context).catch((error: unknown) => {
        logError("feishu", "could not start compaction", error);
        return undefined;
      });
      await sendText(
        chatId,
        started === undefined ? "压缩没起来，看日志。" : "已开始压缩这段对话（后台任务），好了这里会多一条记录。",
      );
      return;
    }
    if (/^\/(stop|abort|停止|中断)$/i.test(command)) {
      await conversation.abort(context);
      await sendText(chatId, "已中断当前任务。");
      return;
    }
    const modelAsk = /^\/(?:model|模型)(?:\s+([\s\S]*))?$/i.exec(command);
    if (modelAsk !== null) {
      if (!isOwner) {
        await sendText(chatId, "只有 alex 能换模型。").catch(() => {});
        return;
      }
      const agent = await conversation.agent(context).catch(() => undefined);
      const provider = agent?.model?.provider ?? config.model.provider;
      const modelId = agent?.model?.modelId ?? config.model.modelId;
      const thinking = agent?.thinkingLevel ?? config.thinkingLevel;
      const catalog = runtime.models().filter((entry) => entry.provider === "magpie");
      const known = new Map(catalog.map((entry) => [entry.id, entry]));
      const ask = parseModelCommand(modelAsk[1] ?? "");

      if (ask.kind === "list") {
        const defaultId = (await runtime.defaultModel().catch(() => undefined))?.modelId;
        // Five buttons fit a card; the rest is `/model <id>`.
        const picks = [modelId, defaultId ?? "", ...catalog.filter((entry) => !entry.id.startsWith("auto/") && !entry.id.startsWith("group/")).map((entry) => entry.id)]
          .filter((id, index, all) => id.length > 0 && all.indexOf(id) === index)
          .slice(0, 5);
        const lines = [
          `当前：\`${provider}/${modelId}\` · thinking **${thinking}**`,
          defaultId === undefined || defaultId.length === 0 ? "" : `默认：\`${defaultId}\`（新会话用它）`,
          "",
          "点一个换本会话，或 `/model <id>`、`/model thinking high`、`/model default <id>`",
        ].filter((line) => line.length > 0);
        await replyCard(
          message.message_id,
          lines.join("\n"),
          "🤖 模型",
          {
            thread: threadFor(message),
            mention: mentionFor(event, message),
            buttons: picks.map((id) => ({
              label: id.split("/").pop() ?? id,
              value: { kind: "set-model", conversationId: conversation.id as unknown as number, provider: "magpie", modelId: id },
              type: id === modelId ? ("primary" as const) : ("default" as const),
            })),
          },
        );
        return;
      }

      if (ask.kind === "default") {
        const entry = known.get(ask.modelId);
        if (entry === undefined) {
          await sendText(chatId, `没有这个模型：${ask.modelId}\n可用的有：${catalog.slice(0, 6).map((item) => item.id).join("、")}`).catch(() => {});
          return;
        }
        await runtime.setDefaultModel({ provider: "magpie", modelId: ask.modelId });
        await sendText(chatId, `默认模型已改为 ${ask.modelId}（新会话生效，当前会话不变）`);
        return;
      }

      if (ask.kind === "thinking") {
        const levels = known.get(modelId)?.thinkingLevels ?? [];
        if (levels.length > 0 && !levels.includes(ask.level)) {
          await sendText(chatId, `思考档位只能是：${levels.join(" / ")}`).catch(() => {});
          return;
        }
        await runtime.setModel(conversation, { provider, modelId, thinkingLevel: ask.level });
        await sendText(chatId, `本会话 thinking 改为 **${ask.level}**（下一轮生效）`.replace(/\*\*/g, ""));
        return;
      }

      const entry = known.get(ask.modelId);
      if (entry === undefined) {
        await sendText(chatId, `没有这个模型：${ask.modelId}\n可用的有：${catalog.slice(0, 6).map((item) => item.id).join("、")}`).catch(() => {});
        return;
      }
      await runtime.setModel(conversation, { provider: "magpie", modelId: ask.modelId, thinkingLevel: thinking });
      await sendText(chatId, `本会话已切到 ${ask.modelId}（下一轮生效）`);
      return;
    }

    if (/^\/(cost|花费|额度)$/i.test(command)) {
      const budget = await runtime.budget(chatId);
      const limit = budget.limit <= 0 ? "未设上限" : `$${budget.limit.toFixed(2)}`;
      await sendText(chatId, `今日花费 $${budget.spentToday.toFixed(4)} / ${limit}`);
      return;
    }
    if (/^\/(memory|记忆)$/i.test(command)) {
      const memory = await runtime.memories(conversation);
      const render = (notes: Array<{ at: string; text: string }>, label: string): string =>
        notes.length === 0
          ? `${label}：空`
          : `${label}（${notes.length}）\n${notes
              .slice(-10)
              .map((note) => `- ${note.at.slice(0, 10)} ${note.text}`)
              .join("\n")}`;
      await replyCard(
        message.message_id,
        `${render(memory.global, "全局记忆")}\n\n${render(memory.chat, "当前对话")}`,
        "🧠 记忆",
      );
      return;
    }
    if (/^\/(project|项目|projects?)(\s|$)/i.test(command)) {
      const wanted = command.replace(/^\/(project|项目|projects?)\s*/i, "").trim();
      const conversationId = conversation.id as unknown as number;
      const projects = await runtime.projects();
      const currentId = await runtime.projectOfConversation(conversationId);

      if (wanted.length === 0) {
        const lines = projects.map(
          (project) => `- ${project.name}${project.id === currentId ? " ← 当前" : ""}\n  \`${project.path}\``,
        );
        await replyCard(
          message.message_id,
          `当前仓库：${projects.find((p) => p.id === currentId)?.name ?? "workspace"}\n\n${lines.join("\n")}\n\n切换：\`/project ${projects[0]?.name ?? "名字"}\``,
          "📦 项目",
          { thread: threadFor(message), mention: mentionFor(event, message) },
        );
        return;
      }
      if (!isOwner) {
        await sendText(chatId, "只有 owner 能切仓库。");
        return;
      }
      const result = await runtime.switchProject(conversationId, wanted);
      if ("error" in result) {
        await sendText(chatId, `${result.error}\n可选：${result.candidates.join("、") || "（无）"}`);
        return;
      }
      await sendText(
        chatId,
        `已切到 ${result.project.name}\n目录：${result.dir}\n分支：${result.branch}\n上下文保留，接着说就行。`,
      );
      return;
    }
    if (/^\/(memo|群记忆|本群记忆)(\s|$)/i.test(command)) {
      const arg = command.replace(/^\/(memo|群记忆|本群记忆)\s*/i, "").trim();
      const conversationId = conversation.id as unknown as number;

      if (arg.length === 0) {
        const notes = await chatNotes(runtime.harness, context, conversationId);
        const body =
          notes.length === 0
            ? "本群还没有专属记忆。\n\n`/memo add 这个群只讨论 Android 客户端` 这样添加，模型每次回答都会看到。"
            : `本群专属记忆（${notes.length}）\n${notes
                .map((note, index) => `${index + 1}. ${note.text}`)
                .join("\n")}\n\n\`/memo add 内容\` · \`/memo del 序号\` · \`/memo clear\``;
        await replyCard(message.message_id, body, "📌 本群记忆", {
          thread: threadFor(message),
          mention: mentionFor(event, message),
        });
        return;
      }
      if (!isOwner) {
        await sendText(chatId, "只有 owner 能改本群记忆。");
        return;
      }
      if (/^clear$/i.test(arg)) {
        const removed = await clearChatNotes(runtime.harness, context, conversationId);
        await sendText(chatId, `已清空本群记忆（删除 ${removed} 条）。`);
        return;
      }
      const del = arg.match(/^(?:del|delete|remove|删)\s+(\d+)$/i);
      if (del !== null) {
        const result = await removeChatNote(runtime.harness, context, conversationId, Number(del[1]));
        await sendText(
          chatId,
          result.removed === undefined
            ? `没有第 ${del[1]} 条（当前 ${result.total} 条）`
            : `已删除：${result.removed}\n还剩 ${result.total} 条`,
        );
        return;
      }
      const text = arg.replace(/^(?:add|set|加|记)\s+/i, "").trim();
      const result = await addChatNote(runtime.harness, context, conversationId, text);
      await sendText(
        chatId,
        result.added
          ? `已记入本群记忆（共 ${result.total} 条）：${text}`
          : `这条已经在记忆里了（共 ${result.total} 条）`,
      );
      return;
    }
    if (/^\/(id|会话)$/i.test(command)) {
      const currentProjectId = await runtime.projectOfConversation(conversation.id as unknown as number);
      // The model belongs on this line: in a topic fork it can differ from the chat's, and
      // `fork: "asOf"` keeps it that way, so "which model answered here" needs an answer.
      const chatMeta = (await runtime.harness.snapshot(SurfaceMetaDoc, context).catch(() => undefined))?.surfaces[chatId];
      const selfName = await agentName(runtime.harness, context).catch(() => undefined);
      const plan = await conversation.agent(context).catch(() => undefined);
      const model = plan?.model === undefined ? `${config.model.provider}/${config.model.modelId}` : `${plan.model.provider}/${plan.model.modelId}`;
      const thinking = plan?.thinkingLevel ?? config.thinkingLevel;
      await sendText(
        chatId,
        [
          `chat: ${chatId}`,
          ...(chatMeta?.chatName === undefined
            ? []
            : [
                `name: ${chatMeta.chatName}${
                  chatMeta.chatOwner === undefined ? "" : ` · 群主 …${chatMeta.chatOwner.slice(-6)}`
                }${chatMeta.members === undefined ? "" : ` · ${chatMeta.members} 人`}`,
              ]),
          `conversation: ${conversation.id}${threadKey === undefined ? "" : `\nthread: ${threadKey}（已 fork）`}`,
          ...(selfName === undefined ? [] : [`agent: ${selfName}`]),
          `model: ${model} · thinking ${thinking}`,
          `project: ${(await runtime.projects()).find((project) => project.id === currentProjectId)?.name ?? "workspace"}`,
        ].join("\n"),
      );
      return;
    }

    const budget = await runtime.budget(chatId);
    const tokensBefore = await tokenTotals(conversation.id as unknown as number).catch(() => ({ total: 0, byModel: new Map() }));
    if (!budget.allowed) {
      await sendText(
        chatId,
        `今日额度已用完（$${budget.spentToday.toFixed(2)} / $${budget.limit.toFixed(2)}）。明天自动重置，或调大 AGENT_DAILY_BUDGET_USD。`,
      );
      return;
    }

    // Feishu redelivers an event whose ack was lost (a long-connection reconnection, a restart),
    // and a replay carries the original message id. That message already has its transcript entry,
    // so the turn is over: without this check the replay finds the finished submission, settles in
    // a second, and posts the old answer again as a brand-new card.
    if ((await lookupMessage(runtime.harness, context, message.message_id).catch(() => undefined)) !== undefined) {
      log("feishu", "duplicate event ignored", { chatId, messageId: message.message_id });
      return;
    }

    log("feishu", "turn start", { chatId, conversationId: conversation.id, type: message.message_type });
    const inGroup = message.chat_type === "group";
    const replyOptions = { thread: threadFor(message), mention: mentionFor(event, message) };
    const cardId = await replyCard(
      message.message_id,
      parsed.audioKey !== undefined
        ? "🎧 听语音…"
        : parsed.imageKeys.length > 0
          ? "🖼️ 看图…"
          : "🤔 收到，处理中…",
      undefined,
      // The card carries its status from the first frame, so it never starts as a bare message and
      // then grows a header when it settles.
      { ...replyOptions, header: WORKING_HEADER },
    );
    if (cardId === undefined) {
      log("feishu", "reply card creation failed, continuing without streaming");
      return;
    }
    log("feishu", "card created", cardId);
    const requestId = `feishu:${message.message_id}`;
    await markCardPending(runtime.harness, context, requestId, {
      cardId,
      chatId,
      conversationId: conversation.id as unknown as number,
      messageId: message.message_id,
      thread: threadFor(message),
    }).catch((error) =>
      logError("feishu", "could not record pending card", error),
    );

    // If the run stalls (provider hang, restart mid-run), say so instead of spinning forever.
    const watchdog = setTimeout(() => {
      if (phase !== "live") return;
      void patchCard(cardId, body, `⏳ ${elapsed()} · 超过 5 分钟，可 /stop 中断`, undefined, WORKING_HEADER).catch(() => {});
    }, 300_000);

    let streamErrors = 0;
    // The card's own life, as one value instead of a flag per concern: only a `live` card may be
    // patched, and settling is a transition rather than "set finished, then remember to check it
    // in every callback that can still fire". A late watcher or heartbeat therefore cannot put
    // "思考中…" back on a finished card, and a new patch site cannot forget the rule.
    let phase: CardPhase = "live";
    let body = "🤔 思考中…";
    const toolsUsed = new Set<string>();
    const watcher = await watchLive(conversation, (live) => {
      if (phase !== "live") return;
      body = renderLive(live);
      for (const tool of live.tools) toolsUsed.add(tool);
      void patchCard(cardId, body, `▶️ 处理中 · ${elapsed()}`, undefined, WORKING_HEADER).catch((error) => {
        if (streamErrors < 3) {
          streamErrors += 1;
          logError("feishu", "stream patch failed", error);
        }
      });
    });

    // A silent model or a long tool round produces no commits, so tick the card
    // ourselves: the user should never have to ask "is it still working?".
    const heartbeat = setInterval(() => {
      if (phase !== "live") return;
      void patchCard(cardId, body, `⏳ ${elapsed()} · 进行中`, undefined, WORKING_HEADER).catch(() => {});
    }, 15_000);

    try {
      const userContent = await buildUserContent(message, parsed, message.chat_type === "p2p" ? undefined : speakerTag(isOwner, senderId));
      const submission = await conversation.submit(
        { type: "input", content: userContent, requestId },
        context,
      );
      await attachSubmission(runtime.harness, context, requestId, submission.id as unknown as number).catch(
        (error) => logError("feishu", "could not attach submission", error),
      );
      log("feishu", "submitted", requestId);
      const settled = await submission.wait(context);
      const seconds = Math.round((Date.now() - startedAt) / 100) / 10;
      log("feishu", "settled", { status: settled.status, reason: settled.reason ?? null, seconds });

      // Freeze live output first, then write the answer.
      phase = "delivering";
      clearInterval(heartbeat);
      clearTimeout(watchdog);
      await watcher.stop();
      if (settled.entry !== undefined) {
        // Remember where this message landed so a later reply can fork at it. The card is
        // indexed too: people reply to the answer, not to their own question, and a thread
        // rooted at the answer is what has to become its own conversation.
        const entryId = settled.entry as unknown as number;
        await runtime
          .recordMessage(message.message_id, conversation, entryId)
          .catch((error) => logError("feishu", "could not index message", error));
        await runtime
          .recordMessage(cardId, conversation, entryId)
          .catch((error) => logError("feishu", "could not index answer card", error));
      }

      if (settled.status === "done" && settled.answer !== undefined) {
        let answer = await runtime.answerText(conversation, settled.answer);
        // The model reads its own earlier "this group is read-only" answers and repeats them,
        // with the owner instructions right in front of it. Correcting once, with the
        // correction last in the context, is what actually unsticks it — verified against the
        // real model: the refusal gave way and the file was edited.
        // ... and only when it did not actually edit anything this turn: a real fix that happens
        // to mention the word 只读 must not be thrown away.
        const edited = toolsUsed.has("write") || toolsUsed.has("edit");
        if (isOwner && isGuestChat && !edited && looksLikeReadOnlyRefusal(answer)) {
          log("feishu", "owner turn answered as read-only, correcting once", { chatId });
          const retry = await conversation
            .submit({ type: "input", content: READ_ONLY_CORRECTION, requestId: `correct:${message.message_id}` }, context)
            .catch((error: unknown) => {
              logError("feishu", "could not submit the correction", error);
              return undefined;
            });
          const again = await retry?.wait(context).catch(() => undefined);
          if (again?.status === "done" && again.answer !== undefined) {
            answer = await runtime.answerText(conversation, again.answer);
            log("feishu", "corrected answer read", { chars: answer.length });
            await note(conversation, context, "模型误以为本群只读而拒绝，已自动纠正一次");
          }
        }
        log("feishu", "answer read", { chars: answer.length });
        const after = await runtime.budget(chatId).catch(() => undefined);
        const cost = after === undefined ? 0 : Math.max(0, after.spentToday - budget.spentToday);
        const tokensAfter = await tokenTotals(conversation.id as unknown as number).catch(() => ({
          total: tokensBefore.total,
          byModel: new Map<string, number>(),
        }));
        let modelUsed = "";
        let biggest = 0;
        for (const [key, tokens] of tokensAfter.byModel) {
          const delta = tokens - (tokensBefore.byModel.get(key) ?? 0);
          if (delta > biggest) {
            biggest = delta;
            modelUsed = key.split("/").pop() ?? key;
          }
        }
        const agentPlan = await conversation.agent(context).catch(() => undefined);
        const meta = turnMeta({
          tools: toolsUsed.size,
          tokens: Math.max(0, tokensAfter.total - tokensBefore.total),
          costUsd: cost,
          model: modelUsed,
          thinking: String(agentPlan?.thinkingLevel ?? ""),
        });
        // The steps are always recorded (the client reads them) and now ride along in the answer
        // card as a folded panel, so a group sees the work too and nothing has to be pressed.
        let steps: Omit<TurnDetails, "at"> | undefined;
        if (settled.entry !== undefined) {
          const taken = await runtime
            .turnSteps(conversation, settled.entry as unknown as number, settled.answer as unknown as number)
            .catch(() => []);
          if (taken.length > 0) {
            steps = { steps: taken, seconds, costUsd: cost };
            await saveTurnDetails(runtime.harness, context, message.message_id, steps).catch((error) =>
              logError("feishu", "could not save turn details", error),
            );
          }
        }
        await deliverAnswer(chatId, cardId, answer || "（模型没有返回文本）", meta, undefined, {
          template: "green",
          title: "✅ 答完了",
        }, steps);
        if (seconds >= config.feishu.donePingSeconds) {
          await pingDone(
            chatId,
            message.message_id,
            `✅ 答完了 · ${seconds}s`,
            { thread: replyOptions.thread === true },
          );
        }
        // A conversation this long makes every step cost about a minute, and the tokens still fit the
        // window, so threshold compaction never fires. Compact on message count instead, after the
        // answer is out, so the user is not left waiting for the next turn to be slow.
        const carried = lastRequestMessages();
        if (carried > COMPACT_AFTER_MESSAGES) {
          log("feishu", "conversation too long, compacting", { chatId, messages: carried });
          await conversation.compact(undefined, context).catch((error: unknown) =>
            logError("feishu", "could not compact a long conversation", error),
          );
        }
      } else if (settled.reason === "turn_limit") {
        // The work sits in the transcript, so ask for the rest instead of making the owner type
        // "继续": a `continue` submission runs the same context with no new user message.
        log("feishu", "turn limit reached, continuing once", { chatId });
        const continued = await conversation
          .submit({ type: "continue", requestId: `continue:${message.message_id}` }, context)
          .catch((error: unknown) => {
            logError("feishu", "could not continue after the turn limit", error);
            return undefined;
          });
        const rest = await continued?.wait(context).catch(() => undefined);
        if (rest?.status === "done" && rest.answer !== undefined) {
          const answer = await runtime.answerText(conversation, rest.answer);
          const after = await runtime.budget(chatId).catch(() => undefined);
          const cost = after === undefined ? 0 : Math.max(0, after.spentToday - budget.spentToday);
          const total = Math.round((Date.now() - startedAt) / 100) / 10;
          // Same rule as turnMeta: the ping below carries the duration, so this line does not.
          const meta = `✅${toolsUsed.size > 0 ? ` · ${toolsUsed.size} 个工具` : ""}${
            cost > 0.00005 ? ` · $${cost.toFixed(4)}` : ""
          } · 到 ${config.maxTurns} 步后续跑 1 次`;
          await deliverAnswer(chatId, cardId, answer || "（模型没有返回文本）", meta, undefined, {
            template: "green",
            title: "✅ 答完了（续跑一次）",
          });
          if (total >= config.feishu.donePingSeconds) {
              await pingDone(
              chatId,
              message.message_id,
              `✅ 答完了（自动续跑一次） · ${total}s`,
              { thread: replyOptions.thread === true },
            );
          }
          await note(conversation, context, `跑到 ${config.maxTurns} 步上限，自动续跑了一次`);
          return;
        }
        await deliverAnswer(
          chatId,
          cardId,
          `这轮跑到 ${config.maxTurns} 步上限，续跑一次仍没收尾（活比较大，不是出错）。\n\n进度都在，点「继续」或回一句「继续」我接着做。`,
          `⏸️ ${seconds}s · 步数上限`,
          continueButton(message.message_id),
          { template: "orange", title: `⏸️ 到了 ${config.maxTurns} 步上限` },
        );
        if (seconds >= config.feishu.donePingSeconds) {
          await pingDone(
            chatId,
            message.message_id,
            `⏸️ 这轮到了 ${config.maxTurns} 步上限，续跑后仍未收尾 · ${seconds}s`,
            { thread: replyOptions.thread === true },
          );
        }
      } else {
        // The header already carries the status and the reason; repeating them in the body made the
        // card say 这次没答出来 twice.
        const reason = settled.reason ?? "unanswered";
        const text = settled.detail === undefined ? "" : `${String(settled.detail)}\n\n`;
        await deliverAnswer(
          chatId,
          cardId,
          `${text}进度都在，点「继续」或回一句「继续」我接着做。`,
          `⏹️ ${seconds}s`,
          continueButton(message.message_id),
          { template: "grey", title: `⚠️ 这次没答出来 · ${reason}` },
        );
        if (seconds >= config.feishu.donePingSeconds) {
          await pingDone(chatId, message.message_id, `⚠️ 这条没答出来（${settled.reason ?? "unanswered"}）· ${seconds}s`, {
            thread: replyOptions.thread === true,
          });
        }
      }
    } catch (error) {
      logError("feishu", "turn failed", error);
      await deliverAnswer(
        chatId,
        cardId,
        `原因：${(error as Error).message}\n\n进度都在，点「继续」可以接着做。`,
        "⏹️ 失败",
        continueButton(message.message_id),
        { template: "red", title: "❌ 出错了" },
      );
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      await watcher.stop();
      await clearCardPending(runtime.harness, context, requestId).catch(() => {});
    }
  }

/** Feishu's own name for a chat, and whose it is. */
async function chatInfo(
  chatId: string,
): Promise<{ name?: string; owner?: string; members?: number; topic?: boolean } | undefined> {
  const response = await client
    .request({ method: "GET", url: `/open-apis/im/v1/chats/${chatId}` })
    .catch((error: unknown) => {
      logError("feishu", "could not read the chat info", error);
      return undefined;
    });
  const data = (
    response as {
      data?: { name?: string; owner_id?: string; user_count?: number; chat_mode?: string; group_message_type?: string };
    }
  )?.data;
  if (data === undefined) return undefined;
  return {
    ...(data.name === undefined || data.name.length === 0 ? {} : { name: data.name }),
    ...(data.owner_id === undefined ? {} : { owner: data.owner_id }),
    ...(typeof data.user_count === "number" ? { members: data.user_count } : {}),
    // A topic group: `group_message_type` is "thread", and every message is its own topic, so an
    // inline answer would start a new topic instead of continuing the conversation.
    ...(data.group_message_type === "thread" || data.chat_mode === "topic" ? { topic: true } : {}),
  };
}

/** Names this process already asked for, so a busy group costs one API call, not one per message. */
const chatNamesKnown = new Set<string>();

/** Topic groups by chat id: known as soon as the chat's info is fetched once. */
const topicChats = new Map<string, boolean>();

/** Once per chat: store Feishu's name (a title the owner set wins) and whose group it is. */
async function rememberChatInfo(chatId: string): Promise<void> {
  if (chatNamesKnown.has(chatId)) return;
  chatNamesKnown.add(chatId);
  const info = await chatInfo(chatId);
  if (info === undefined) return;
  const meta = (await runtime.harness.snapshot(SurfaceMetaDoc, context).catch(() => undefined))?.surfaces[chatId];
  topicChats.set(chatId, info.topic === true);
  await updateSurfaceMeta(runtime.harness, context, chatId, {
    ...(info.topic === undefined ? {} : { topic: info.topic }),
    ...(info.name === undefined ? {} : { chatName: info.name }),
    ...(info.owner === undefined ? {} : { chatOwner: info.owner }),
    ...(info.members === undefined ? {} : { members: info.members }),
    // A name the owner set (or an earlier title) is never overwritten; an empty one takes the
    // group's own name, which reads better in the rail than a fragment of the first message.
    ...(info.name !== undefined && (meta?.title === undefined || meta.title.length === 0)
      ? { title: info.name }
      : {}),
  }).catch((error: unknown) => logError("feishu", "could not store the chat info", error));
}

/** At boot: fill in names for chats that already have a conversation but no name yet. */
async function backfillChatNames(): Promise<void> {
  const mapping = await runtime.harness.snapshot(ChatsToken, context).catch(() => undefined);
  const known = Object.keys(mapping?.chats ?? {}).filter((chatId) => chatId.startsWith("oc_"));
  const meta = (await runtime.harness.snapshot(SurfaceMetaDoc, context).catch(() => undefined))?.surfaces ?? {};
  const missing = known.filter((chatId) => (meta[chatId]?.chatName ?? "").length === 0);
  for (const chatId of missing) await rememberChatInfo(chatId);
  if (missing.length > 0) log("feishu", "chat names filled in", { chats: missing.length });
}

/** Per-model token totals of one conversation, so a turn's spend is a difference. */
async function tokenTotals(conversationId: number): Promise<{ total: number; byModel: Map<string, number> }> {
  const doc = await runtime.harness.snapshot(UsageDoc, conversationId as never, context).catch(() => undefined);
  const byModel = new Map<string, number>();
  let total = 0;
  for (const [key, usage] of Object.entries(doc?.models ?? {})) {
    const tokens = Number((usage as { totalTokens?: number }).totalTokens ?? 0);
    byModel.set(key, tokens);
    total += tokens;
  }
  return { total, byModel };
}

  /** One quoted message by id; undefined when it cannot be read (deleted, no scope, gone). */
  async function readQuoted(parentId: string): Promise<Quoted | undefined> {
    const hit = quotedCache.get(parentId);
    if (hit !== undefined && Date.now() - hit.at < QUOTED_TTL_MS) return hit.value;
    const response = await client.im.message
      .get({ path: { message_id: parentId } })
      .catch((error: unknown) => {
        logError("feishu", "could not read the quoted message", error);
        return undefined;
      });
    const item = response?.data?.items?.[0];
    const value: Quoted | undefined =
      item === undefined || item.deleted === true
        ? undefined
        : {
            who: item.sender?.sender_type === "app" ? "bot" : `ou_${String(item.sender?.id ?? "?").slice(-6)}`,
            text: quoteText(
              item.msg_type ?? "",
              item.body?.content ?? "",
              // The API's mentions carry the open_id as a string; ours carry it one level down.
              (item.mentions ?? []).map((mention) => ({ key: mention.key, name: mention.name, id: { open_id: mention.id } })),
            ),
          };
    quotedCache.set(parentId, { at: Date.now(), value });
    if (quotedCache.size > QUOTED_CACHE_MAX) {
      const oldest = quotedCache.keys().next().value;
      if (oldest !== undefined) quotedCache.delete(oldest);
    }
    return value;
  }

  async function buildUserContent(
    message: NonNullable<IncomingMessage["message"]>,
    parsed: ParsedContent,
    speaker?: string,
  ): Promise<string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
    /** Who is talking, on its own line, so a long turn does not read as the assistant's own. */
    const tag = (text: string): string => (speaker === undefined ? text : `${speaker} ${text}`);
    // A reply carries the id of the message it answers, never its text: "这个怎么改" needs the quote.
    const quotedId = quotedParentId(message);
    const quoted = quotedId.length > 0 ? await readQuoted(quotedId) : undefined;
    if (quoted !== undefined) log("feishu", "quoted message attached", { id: quotedId.slice(-8), chars: quoted.text.length });
    const withQuote = (text: string): string => (quoted === undefined ? tag(text) : tag(`${quoteBlock(quoted)}${text}`));
    if (parsed.audioKey !== undefined) {
      const bytes = await downloadResource(message.message_id ?? "", parsed.audioKey, "file");
      if (bytes === undefined) return withQuote(`${parsed.text}\n（语音下载失败）`.trim());
      const asr = await transcribeAudio(bytes, "opus");
      if (!asr.ok) return withQuote(`${parsed.text}\n（语音转写失败：${asr.error}）`.trim());
      if (asr.text.length === 0) return withQuote(`${parsed.text}\n（语音里没听出内容）`.trim());
      return withQuote(`[语音转写] ${asr.text}${parsed.text.length > 0 ? `\n（随语音附带的文字）${parsed.text}` : ""}`);
    }
    if (parsed.imageKeys.length === 0) return withQuote(parsed.text);
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const key of parsed.imageKeys.slice(0, 3)) {
      const image = await downloadImage(message.message_id ?? "", key);
      if (image !== undefined) images.push({ type: "image" as const, ...image });
      else console.warn(`[feishu] image ${key} could not be downloaded`);
    }
    if (images.length === 0) {
      return withQuote(`${parsed.text}\n（图片下载失败，只看到文字）`.trim());
    }
    // Anchor the model on the picture: without this it tends to keep talking about
    // whatever the previous turns were about and treat the image as decoration.
    const who = speaker === undefined ? "alex" : speaker;
    const hint = `${who} 发来 ${images.length} 张图片，先依据图片内容回答，图片是这条消息的主体`;
    const caption = parsed.text.length > 0 ? `${hint}\n${parsed.text}` : `${hint}\n看看这张图，告诉我重点。`;
    return [{ type: "text" as const, text: withQuote(caption) }, ...images];
  }

  const eventDispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: IncomingMessage) => {
      // Never let a bad event take down the long connection.
      await handle(data).catch((error) => console.error("[feishu] handler failed", error));
    },
    "card.action.trigger": async (data: CardAction) => {
      try {
        return await handleCardAction(data);
      } catch (error) {
        console.error("[feishu] card action failed", error);
        return {};
      }
    },
  });

  if (config.feishu.allowedChatIds.length === 0 && config.feishu.allowedSenderIds.length === 0) {
    console.warn(
      "[feishu] no allowlist configured: anyone who can reach this bot can run read/write/edit/bash. " +
        "Send one message, then copy the logged chat/sender ids into FEISHU_ALLOWED_CHAT_IDS / FEISHU_ALLOWED_SENDER_IDS.",
    );
  }

  const loggerLevel =
    (process.env.FEISHU_LOG_LEVEL ?? "info") === "debug" ? Lark.LoggerLevel.debug : Lark.LoggerLevel.info;
  const wsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel,
    // Connection state is not obvious from the SDK's own logs; make flapping visible.
    onReady: () => {
      console.log("[feishu] ws ready");
      feishuStatus.ready = true;
      feishuStatus.since = Date.now();
    },
    onError: (error: unknown) => {
      feishuStatus.ready = false;
      feishuStatus.flaps += 1;
      feishuStatus.lastError = (error as Error)?.message ?? String(error);
      console.error(`[feishu] ws error: ${feishuStatus.lastError}`);
    },
    onReconnecting: () => {
      feishuStatus.ready = false;
      console.warn("[feishu] ws reconnecting");
    },
    onReconnected: () => {
      feishuStatus.ready = true;
      feishuStatus.since = Date.now();
      console.log("[feishu] ws reconnected");
    },
  });
  await wsClient.start({ eventDispatcher });
  log("feishu", `long connection established for app ${appId}`);
  void backfillChatNames().catch((error: unknown) => logError("feishu", "could not backfill chat names", error));

  // The SDK stops retrying once it gives up, and a long connection that dies silently
  // is indistinguishable from a bot nobody talks to. Restart it ourselves when it stays
  // down; while it is down, events published by Feishu are lost, not queued.
  let lastAttempt = Date.now();
  const supervisor = setInterval(() => {
    if (feishuStatus.ready) return;
    const down = Date.now() - feishuStatus.since;
    if (down < 120_000 || Date.now() - lastAttempt < 120_000) return;
    lastAttempt = Date.now();
    logError("feishu", `long connection down ${Math.round(down / 1000)}s, restarting it`, undefined);
    void wsClient.start({ eventDispatcher }).catch((error: unknown) => {
      feishuStatus.lastError = (error as Error)?.message ?? String(error);
      logError("feishu", "could not restart long connection", error);
    });
  }, 30_000);

  // A crash or redeploy leaves the conversation resuming in this process while the
  // old card has no owner. Reacquire the submission, wait for it, deliver the answer
  // as a message, and close the card — the durable equivalent of "it kept working".
  void (async () => {
    // Only cards from before this process started. A turn that begins while this loop runs creates a
    // placeholder card too, and treating it as a leftover delivered the same finished answer twice.
    const bootedAt = Date.now();
    const leftovers = await leftoverCards(runtime.harness, context, bootedAt).catch(() => []);
    for (const card of leftovers) {
      const attempt = await noteCardAttempt(runtime.harness, context, card.requestId).catch(() => 0);
      if (attempt > 3) {
        // Feishu rejects the card or the chat (a placeholder written while testing, a group
        // the bot left). Retrying every boot only produced two failed calls per restart.
        logError("feishu", `giving up on a card after ${attempt - 1} recovery attempts`, {
          cardId: card.cardId,
          chatId: card.chatId,
        });
        await clearCardPending(runtime.harness, context, card.requestId).catch(() => {});
        continue;
      }
      log("feishu", "unfinished card from previous process", { cardId: card.cardId, submissionId: card.submissionId });
      const startedAt = clock(card.at);
      const elapsed = duration(Date.now() - card.at);
      if (card.submissionId === undefined) {
        await patchCard(
          card.cardId,
          `🔁 进程重启过，这条消息没来得及提交（${startedAt} 发出）。麻烦再发一次。`,
          `🔁 未提交 · ${elapsed} 前`,
        ).catch(() => {});
        await clearCardPending(runtime.harness, context, card.requestId).catch(() => {});
        continue;
      }
      await patchCard(
        card.cardId,
        `🔁 进程重启过，这条任务已在后台恢复。\n\n开始于 ${startedAt}，已跑 ${elapsed}，结果稍后单独发你。`,
        `🔁 已恢复 · ${startedAt} 起`,
      ).catch(() => {});
      void (async () => {
        try {
          const submission = await runtime.harness.submission(
            card.submissionId as unknown as Parameters<typeof runtime.harness.submission>[0],
            context,
          );
          if (submission === undefined) throw new Error("submission gone");
          const settled = await submission.wait(context);
          const conversation = await runtime.harness.conversation(
            card.conversationId as unknown as Parameters<typeof runtime.harness.conversation>[0],
            context,
          );
          const total = duration(Date.now() - card.at);
          // The run may have been resumed by the new process's own turn handler, which delivers the
          // answer and clears the mark. Delivering it here as well is what posted the same message
          // twice — once inside the topic as a card, once in the chat as text.
          // One transition replaces two guards: whichever process moves the card live → delivering
          // posts the answer, and the other finds it taken. `gone` means the live turn already
          // delivered and cleared its mark.
          const taken = await moveCard(
            runtime.harness,
            context,
            card.requestId,
            "live",
            "delivering",
            `recover:${process.pid}`,
          );
          if (!taken.moved) {
            log("feishu", "recovered answer already taken", { cardId: card.cardId, phase: taken.found });
            return;
          }
          log("feishu", "recovered delivery footer", `${startedAt} 起 · ${total}`);
          if (settled.status === "done" && settled.answer !== undefined && conversation !== undefined) {
            const answer = await runtime.answerText(conversation, settled.answer);
            await replyOrSend(
              card.chatId,
              card.messageId,
              card.thread,
              answer.length > 0 ? answer : "（模型没有返回文本）",
              `✅ ${total} · ${startedAt} 起，中途进程重启过`,
              { template: "green", title: "✅ 答完了（重启后补发）" },
            );
            log("feishu", "recovered answer delivered", { chatId: card.chatId, chars: answer.length, total });
            await note(
              conversation,
              context,
              `进程重启过，把上次那条答完了（${startedAt} 起，${total}）`,
            );
          } else {
            await replyOrSend(
              card.chatId,
              card.messageId,
              card.thread,
              settled.reason === "turn_limit"
                ? `上次那条跑到 ${config.maxTurns} 步上限就停了（工作是接着跑的，进度都在）。回一句「继续」我接着做。`
                : `上次那条没答出来（${settled.reason ?? "unanswered"}）。回一句「继续」我接着做。`,
              `${startedAt} 起 · ${total}`,
              standaloneHeader(settled.reason),
            );
          }
        } catch (error) {
          logError("feishu", "could not recover answer", error);
          await replyOrSend(
            card.chatId,
            card.messageId,
            card.thread,
            "上次那条恢复失败，麻烦再发一次。",
            `❌ 恢复失败`,
            { template: "red", title: "❌ 恢复失败" },
          ).catch(() => {});
        } finally {
          await clearCardPending(runtime.harness, context, card.requestId).catch(() => {});
        }
      })();
    }
  })();

  return {
    stop() {
      clearInterval(supervisor);
      // Every waiter is told no and no timer survives; the registry is the only place that knows
      // what was still pending.
      dropAllApprovals();
      wsClient.close({ force: true });
    },
  };
}

function sniff(bytes: Buffer): string {
  if (bytes.length > 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length > 12 && bytes.subarray(8, 12).toString() === "WEBP") return "image/webp";
  if (bytes.length > 6 && bytes.subarray(0, 3).toString() === "GIF") return "image/gif";
  return "image/png";
}
