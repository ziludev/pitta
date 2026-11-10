import * as Lark from "@larksuiteoapi/node-sdk";

export type Check = { ok: boolean; level: "ok" | "warn" | "bad"; label: string; hint?: string };

/**
 * Everything the Feishu console can get wrong, read back through the API: credentials,
 * bot, delivery mode, published version, subscribed events, scopes and send permission.
 * This is the part of onboarding that makes people give up.
 */
export async function checkFeishu(appId: string, appSecret: string): Promise<Check[]> {
  const checks: Check[] = [];
  if (appId.length === 0 || appSecret.length === 0) {
    return [{ ok: false, level: "bad", label: "FEISHU_APP_ID / FEISHU_APP_SECRET 未配置", hint: "agent setup" }];
  }

  const client = new Lark.Client({ appId, appSecret });
  const token = await client.auth.v3.tenantAccessToken
    .internal({ data: { app_id: appId, app_secret: appSecret } })
    .catch(() => undefined);
  if (token?.code !== 0) {
    return [{ ok: false, level: "bad", label: "App ID / Secret 无效（拿不到 tenant token）", hint: "开发者后台 → 凭证与基础信息" }];
  }
  checks.push({ ok: true, level: "ok", label: "凭证有效" });

  const bot = await client.request({ method: "GET", url: "/open-apis/bot/v3/info" }).catch(() => undefined);
  const botName = (bot?.bot as { app_name?: string } | undefined)?.app_name;
  checks.push(
    botName === undefined
      ? { ok: false, level: "bad", label: "应用没有机器人能力", hint: "添加「机器人」能力后发布版本" }
      : { ok: true, level: "ok", label: `机器人可用：${botName}` },
  );

  const app = await client
    .request({ method: "GET", url: `/open-apis/application/v6/applications/${appId}`, params: { lang: "zh_cn" } })
    .then((response) => (response?.data as { app?: Record<string, unknown> } | undefined)?.app)
    .catch(() => undefined);

  const callbackInfo = app?.["callback_info"] as
    | { callback_type?: string; subscribed_callbacks?: string[] }
    | undefined;
  const mode = callbackInfo?.callback_type;
  checks.push(
    mode === "websocket"
      ? { ok: true, level: "ok", label: "事件订阅方式：长连接" }
      : {
          ok: false,
          level: "bad",
          label: `事件订阅方式不是长连接（当前 ${mode ?? "未配置"}）`,
          hint: "事件与回调 → 订阅方式 → 使用长连接接收事件",
        },
  );

  const versions = await client
    .request({
      method: "GET",
      url: `/open-apis/application/v6/applications/${appId}/app_versions`,
      params: { lang: "zh_cn", page_size: 20 },
    })
    .then((response) => ((response?.data as { items?: Array<Record<string, unknown>> } | undefined)?.items ?? []))
    .catch(() => []);
  const onlineId = app?.["online_version_id"];
  const online = versions.find((version) => version["version_id"] === onlineId);
  if (online === undefined) {
    checks.push({ ok: false, level: "bad", label: "没有已发布的版本", hint: "版本管理与发布 → 创建版本 → 申请发布" });
  } else {
    checks.push({ ok: true, level: "ok", label: `在线版本 ${String(online["version"] ?? "")}` });
    const events = ((online["event_infos"] as Array<{ event_type?: string }> | undefined) ?? []).map(
      (event) => event.event_type ?? "",
    );
    const needed = ["im.message.receive_v1"];
    const missing = needed.filter((event) => !events.includes(event));
    checks.push(
      missing.length === 0
        ? { ok: true, level: "ok", label: "已订阅「接收消息」事件" }
        : {
            ok: false,
            level: "bad",
            label: `在线版本缺事件：${missing.join(", ")}`,
            hint: "事件与回调 → 添加事件 → 接收消息，然后重新发布",
          },
    );
    const callbacks = callbackInfo?.subscribed_callbacks ?? [];
    if (!callbacks.includes("card.action.trigger")) {
      checks.push({ ok: false, level: "warn", label: "没有订阅卡片回调（审批按钮点不动）", hint: "添加回调 card.action.trigger" });
    } else {
      checks.push({ ok: true, level: "ok", label: "已订阅卡片回调" });
    }
  }

  const scopes = ((app?.["scopes"] as Array<{ scope?: string }> | undefined) ?? []).map((scope) => scope.scope ?? "");
  const required = ["im:message:send_as_bot", "im:message.p2p_msg:readonly", "im:message.group_at_msg:readonly"];
  const missingScopes = required.filter((scope) => !scopes.includes(scope));
  checks.push(
    missingScopes.length === 0
      ? { ok: true, level: "ok", label: "消息收发权限齐全" }
      : { ok: false, level: "bad", label: `缺权限：${missingScopes.join(", ")}`, hint: "权限管理 → 开通后重新发布" },
  );

  // Without this one the app only ever sees group messages that @ it, so a topic reply
  // typed without a mention never reaches us — indistinguishable from a broken bot.
  const seesAllGroupMessages = scopes.includes("im:message.group_msg");
  checks.push(
    seesAllGroupMessages
      ? { ok: true, level: "ok", label: "能收到群里所有消息（不 @ 也算）" }
      : {
          ok: false,
          level: "warn",
          label: "只收群里 @ 我的消息，话题里不 @ 的话不会回复",
          hint: `开通 im:message.group_msg 后重新发布：https://open.feishu.cn/app/${appId}/auth?q=im:message.group_msg`,
        },
  );

  const chats = await client.im.chat.list({ params: { page_size: 5 } }).catch(() => undefined);
  const items = ((chats?.data as { items?: unknown[] } | undefined)?.items ?? []).length;
  checks.push(
    items === 0
      ? { ok: false, level: "warn", label: "机器人还不在任何群里（单聊可以先试）", hint: "把机器人拉进群，或在飞书里搜它" }
      : { ok: true, level: "ok", label: `机器人在 ${items} 个群里` },
  );

  return checks;
}
