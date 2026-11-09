import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Lark from "@larksuiteoapi/node-sdk";
import { config, requireFeishuCredentials } from "./config.ts";
import { context, type AgentRuntime } from "./harness.ts";
import { watchLive, type LiveSnapshot } from "./live.ts";
import { setApprovalDecider, setNotifier, type ApprovalRequest } from "./channel.ts";
import { log, logError } from "./log.ts";
import { transcribeAudio } from "./asr.ts";
import { attachSubmission, clearCardPending, leftoverCards, markCardPending } from "./cards.ts";
import { readTurnDetails, saveTurnDetails, type TurnDetails } from "./details.ts";

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
    mentions?: Array<{ key?: string; name?: string }>;
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
  "- `/id` 当前 chat 与 conversation",
  "",
  "直接说话就行：能查文件、跑命令、定时提醒、记长期记忆。",
].join("\n");

type CardButton = { label: string; value: Record<string, unknown>; type?: "primary" | "danger" | "default" };

function card(markdown: string, meta?: string, buttons?: CardButton[]): Record<string, unknown> {
  const elements: Array<Record<string, unknown>> = [{ tag: "markdown", content: markdown }];
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
  return { config: { wide_screen_mode: true, update_multi: true }, elements };
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

function approvalCard(request: ApprovalRequest): Record<string, unknown> {
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

function stripMentions(message: NonNullable<IncomingMessage["message"]>, text: string): string {
  // Feishu renders mentions as "@_user_1"; drop them so the model sees a clean sentence.
  let out = text;
  for (const mention of message.mentions ?? []) {
    if (mention.key) out = out.split(mention.key).join("@");
  }
  return out.trim();
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

function rejectionReason(
  event: IncomingMessage,
  parsedContent: ParsedContent,
): string | undefined {
  const message = event.message;
  const chatId = message?.chat_id ?? "";
  const senderId = event.sender?.sender_id?.open_id ?? "";
  const { allowedChatIds, allowedSenderIds, mentionsOnly } = config.feishu;
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
  if (allowedChatIds.length > 0 && !allowedChatIds.includes(chatId)) return "chat-not-allowed";
  if (allowedSenderIds.length > 0 && !allowedSenderIds.includes(senderId)) return "sender-not-allowed";
  if (mentionsOnly && message?.chat_type === "group" && (message.mentions ?? []).length === 0) {
    return "group-message-without-mention";
  }
  return undefined;
}

type PendingApproval = {
  resolve: (approved: boolean) => void;
  timer: NodeJS.Timeout;
  chatId: string;
};

export type FeishuBridge = { stop(): void };

export async function startFeishuBridge(runtime: AgentRuntime): Promise<FeishuBridge> {
  const { appId, appSecret } = requireFeishuCredentials();
  const client = new Lark.Client({ appId, appSecret });
  const handled = new Set<string>();
  const pendingApprovals = new Map<string, PendingApproval>();

  async function sendText(chatId: string, text: string): Promise<void> {
    await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    });
  }

  async function patchCard(
    messageId: string,
    markdown: string,
    meta?: string,
    buttons?: CardButton[],
  ): Promise<void> {
    const response = await client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card(markdown, meta, buttons)) },
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
  async function deliverAnswer(
    chatId: string,
    cardId: string,
    markdown: string,
    meta: string,
    buttons?: CardButton[],
  ): Promise<void> {
    try {
      await patchCard(cardId, markdown, meta, buttons);
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

  async function replyCard(messageId: string, markdown: string, meta?: string): Promise<string | undefined> {
    const response = await client.im.message.reply({
      path: { message_id: messageId },
      data: { msg_type: "interactive", content: JSON.stringify(card(markdown, meta ?? "▶️ 处理中")) },
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
    await sendText(surfaceId, text);
  });
  setApprovalDecider(async (request) => {
    if (request.surfaceId.length === 0) return false;
    const sent = await client.im.message.create({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: request.surfaceId,
        msg_type: "interactive",
        content: JSON.stringify(approvalCard(request)),
      },
    });
    const cardId = sent?.data?.message_id;
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        pendingApprovals.delete(request.callId);
        if (cardId !== undefined) {
          void patchCard(cardId, `⏹️ 超时未确认，已拒绝：${request.tool}`).catch(() => {});
        }
        resolve(false);
      }, request.timeoutMs);
      pendingApprovals.set(request.callId, { resolve, timer, chatId: request.surfaceId });
    });
  });

  async function handleCardAction(payload: CardAction): Promise<Record<string, unknown>> {
    const value = payload.action?.value ?? {};

    if (value["kind"] === "detail") {
      const messageId = typeof value["messageId"] === "string" ? value["messageId"] : "";
      const chatId = payload.context?.open_chat_id ?? "";
      const details = await readTurnDetails(runtime.harness, context, messageId);
      if (details === undefined) return { toast: { type: "info", content: "这轮没有工具调用记录" } };
      if (chatId.length > 0) {
        await client.im.message.create({
          params: { receive_id_type: "chat_id" },
          data: {
            receive_id: chatId,
            msg_type: "interactive",
            content: JSON.stringify(card(renderDetails(details), "🔍 本轮执行详情")),
          },
        });
      }
      return { toast: { type: "success", content: "详情已发送" } };
    }

    const callId = typeof value["approval"] === "string" ? value["approval"] : "";
    const operator = payload.operator?.open_id ?? "";
    const entry = pendingApprovals.get(callId);
    if (entry === undefined) return { toast: { type: "info", content: "已处理" } };

    const { allowedSenderIds } = config.feishu;
    if (allowedSenderIds.length > 0 && !allowedSenderIds.includes(operator)) {
      return { toast: { type: "warning", content: "只有主人可以确认" } };
    }

    pendingApprovals.delete(callId);
    clearTimeout(entry.timer);
    const approved = value["ok"] === true;
    entry.resolve(approved);
    const messageId = payload.context?.open_message_id;
    if (messageId !== undefined) {
      const text = approved ? "✅ 已允许，继续执行" : "🛑 已拒绝";
      await patchCard(messageId, text, `由 ${operator.slice(-6)} 确认`).catch(() => {});
    }
    return { toast: { type: "success", content: approved ? "已允许" : "已拒绝" } };
  }

  async function handle(event: IncomingMessage): Promise<void> {
    const message = event.message;
    if (message?.message_id === undefined || message.chat_id === undefined) return;
    const parsed = parseContent(message);
    const text = parsed.text;
    const reason = rejectionReason(event, parsed);
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
      } text=${JSON.stringify(text.slice(0, 60))}`,
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
    const command = text.trim();

    if (/^\/(help|帮助)$/i.test(command)) {
      await replyCard(message.message_id, HELP, "💡 命令一览");
      return;
    }
    if (/^\/(new|reset|新会话|清空)$/i.test(command)) {
      await conversation.reset(undefined, context);
      await sendText(chatId, "已开新会话。历史还在存储里，长期记忆也保留。");
      return;
    }
    if (/^\/(stop|abort|停止|中断)$/i.test(command)) {
      await conversation.abort(context);
      await sendText(chatId, "已中断当前任务。");
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
    if (/^\/(id|会话)$/i.test(command)) {
      await sendText(
        chatId,
        `chat: ${chatId}\nconversation: ${conversation.id}${threadKey === undefined ? "" : `\nthread: ${threadKey}（已 fork）`}`,
      );
      return;
    }

    const budget = await runtime.budget(chatId);
    if (!budget.allowed) {
      await sendText(
        chatId,
        `今日额度已用完（$${budget.spentToday.toFixed(2)} / $${budget.limit.toFixed(2)}）。明天自动重置，或调大 AGENT_DAILY_BUDGET_USD。`,
      );
      return;
    }

    log("feishu", "turn start", { chatId, conversationId: conversation.id, type: message.message_type });
    const cardId = await replyCard(
      message.message_id,
      parsed.audioKey !== undefined
        ? "🎧 听语音…"
        : parsed.imageKeys.length > 0
          ? "🖼️ 看图…"
          : "🤔 收到，处理中…",
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
    }).catch((error) =>
      logError("feishu", "could not record pending card", error),
    );

    // If the run stalls (provider hang, restart mid-run), say so instead of spinning forever.
    const watchdog = setTimeout(() => {
      void patchCard(cardId, body, `⏳ ${elapsed()} · 超过 5 分钟，可 /stop 中断`).catch(() => {});
    }, 300_000);

    let streamErrors = 0;
    let body = "🤔 思考中…";
    const toolsUsed = new Set<string>();
    const watcher = await watchLive(conversation, (live) => {
      body = renderLive(live);
      for (const tool of live.tools) toolsUsed.add(tool);
      void patchCard(cardId, body, `▶️ 处理中 · ${elapsed()}`).catch((error) => {
        if (streamErrors < 3) {
          streamErrors += 1;
          logError("feishu", "stream patch failed", error);
        }
      });
    });

    // A silent model or a long tool round produces no commits, so tick the card
    // ourselves: the user should never have to ask "is it still working?".
    const heartbeat = setInterval(() => {
      void patchCard(cardId, body, `⏳ ${elapsed()} · 进行中`).catch(() => {});
    }, 15_000);

    try {
      const userContent = await buildUserContent(message, parsed);
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
      if (settled.entry !== undefined) {
        // Remember where this message landed so a later reply can fork at it.
        await runtime
          .recordMessage(message.message_id, conversation, settled.entry as unknown as number)
          .catch((error) => logError("feishu", "could not index message", error));
      }

      if (settled.status === "done" && settled.answer !== undefined) {
        const answer = await runtime.answerText(conversation, settled.answer);
        log("feishu", "answer read", { chars: answer.length });
        const after = await runtime.budget(chatId).catch(() => undefined);
        const cost = after === undefined ? 0 : Math.max(0, after.spentToday - budget.spentToday);
        const meta = `✅ ${seconds}s${toolsUsed.size > 0 ? ` · ${toolsUsed.size} 个工具` : ""}${
          cost > 0.00005 ? ` · $${cost.toFixed(4)}` : ""
        }`;
        let buttons: CardButton[] | undefined;
        if (settled.entry !== undefined) {
          const steps = await runtime
            .turnSteps(conversation, settled.entry as unknown as number, settled.answer as unknown as number)
            .catch(() => []);
          if (steps.length > 0) {
            await saveTurnDetails(runtime.harness, context, message.message_id, {
              steps,
              seconds,
              costUsd: cost,
            }).catch((error) => logError("feishu", "could not save turn details", error));
            buttons = [{ label: "查看详情", value: { kind: "detail", messageId: message.message_id } }];
          }
        }
        await deliverAnswer(chatId, cardId, answer || "（模型没有返回文本）", meta, buttons);
      } else {
        const reasonText = settled.reason ?? "unanswered";
        const detail = settled.detail === undefined ? "" : `\n\n${String(settled.detail)}`;
        await deliverAnswer(chatId, cardId, `⚠️ 这次没有答出来：${reasonText}${detail}`, `⏹️ ${seconds}s`);
      }
    } catch (error) {
      logError("feishu", "turn failed", error);
      await deliverAnswer(chatId, cardId, `❌ 出错：${(error as Error).message}`, "⏹️ 失败");
    } finally {
      clearTimeout(watchdog);
      clearInterval(heartbeat);
      await watcher.stop();
      await clearCardPending(runtime.harness, context, requestId).catch(() => {});
    }
  }

  async function buildUserContent(
    message: NonNullable<IncomingMessage["message"]>,
    parsed: ParsedContent,
  ): Promise<string | Array<{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }>> {
    if (parsed.audioKey !== undefined) {
      const bytes = await downloadResource(message.message_id ?? "", parsed.audioKey, "file");
      if (bytes === undefined) return `${parsed.text}\n（语音下载失败）`.trim();
      const asr = await transcribeAudio(bytes, "opus");
      if (!asr.ok) return `${parsed.text}\n（语音转写失败：${asr.error}）`.trim();
      if (asr.text.length === 0) return `${parsed.text}\n（语音里没听出内容）`.trim();
      return `[语音转写] ${asr.text}${parsed.text.length > 0 ? `\n（随语音附带的文字）${parsed.text}` : ""}`;
    }
    if (parsed.imageKeys.length === 0) return parsed.text;
    const images: Array<{ type: "image"; data: string; mimeType: string }> = [];
    for (const key of parsed.imageKeys.slice(0, 3)) {
      const image = await downloadImage(message.message_id ?? "", key);
      if (image !== undefined) images.push({ type: "image" as const, ...image });
      else console.warn(`[feishu] image ${key} could not be downloaded`);
    }
    if (images.length === 0) {
      return `${parsed.text}\n（图片下载失败，只看到文字）`.trim();
    }
    // Anchor the model on the picture: without this it tends to keep talking about
    // whatever the previous turns were about and treat the image as decoration.
    const hint = `[主人发来 ${images.length} 张图片，先依据图片内容回答，图片是这条消息的主体]`;
    const caption = parsed.text.length > 0 ? `${hint}\n${parsed.text}` : `${hint}\n看看这张图，告诉我重点。`;
    return [{ type: "text" as const, text: caption }, ...images];
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
    onReady: () => console.log("[feishu] ws ready"),
    onError: (error: unknown) =>
      console.error(`[feishu] ws error: ${(error as Error)?.message ?? String(error)}`),
    onReconnecting: () => console.warn("[feishu] ws reconnecting"),
    onReconnected: () => console.log("[feishu] ws reconnected"),
  });
  await wsClient.start({ eventDispatcher });
  log("feishu", `long connection established for app ${appId}`);

  // A crash or redeploy leaves the conversation resuming in this process while the
  // old card has no owner. Reacquire the submission, wait for it, deliver the answer
  // as a message, and close the card — the durable equivalent of "it kept working".
  void (async () => {
    const leftovers = await leftoverCards(runtime.harness, context).catch(() => []);
    for (const card of leftovers) {
      log("feishu", "unfinished card from previous process", { cardId: card.cardId, submissionId: card.submissionId });
      if (card.submissionId === undefined) {
        await patchCard(card.cardId, "🔁 进程重启过，这条消息没来得及提交。麻烦再发一次。", "🔁 未提交").catch(() => {});
        await clearCardPending(runtime.harness, context, card.requestId).catch(() => {});
        continue;
      }
      await patchCard(card.cardId, "🔁 进程重启过，这条任务已在后台恢复，结果稍后单独发你。", "🔁 已恢复").catch(() => {});
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
          if (settled.status === "done" && settled.answer !== undefined && conversation !== undefined) {
            const answer = await runtime.answerText(conversation, settled.answer);
            await sendText(card.chatId, answer.length > 0 ? answer : "（模型没有返回文本）");
            log("feishu", "recovered answer delivered", { chatId: card.chatId, chars: answer.length });
          } else {
            await sendText(card.chatId, `上次那条没答出来：${settled.reason ?? "unanswered"}`);
          }
        } catch (error) {
          logError("feishu", "could not recover answer", error);
          await sendText(card.chatId, "上次那条恢复失败，麻烦再发一次。").catch(() => {});
        } finally {
          await clearCardPending(runtime.harness, context, card.requestId).catch(() => {});
        }
      })();
    }
  })();

  return {
    stop() {
      for (const entry of pendingApprovals.values()) {
        clearTimeout(entry.timer);
        entry.resolve(false);
      }
      pendingApprovals.clear();
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
