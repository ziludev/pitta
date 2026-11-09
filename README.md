# pi-durable-agent

一个跑在 [Pi Durable](https://earendil.com/posts/pi-durable/) 上的私人助理：在飞书里聊天，进程挂了、机器重启，对话和提醒都不丢。

- 引擎：`@earendil-works/pi-durable` 1.5.0 — 任务级 checkpoint、崩溃续跑、durable 定时任务、多会话并发、后台压缩
- 模型：`@earendil-works/pi-ai`，默认走本机 magpie 代理（OpenAI 兼容），可换任意内置 provider
- 存储：SQLite（`.data/agent.sqlite`），单进程独占，重启原样恢复
- 入口：飞书自建应用 + **长连接**（不需要公网 IP / 域名 / 证书）
- 常驻：launchd（`KeepAlive`），崩了自动拉起

## 能力

| 能力 | 实现 |
|---|---|
| 对话 | 每个飞书 chat 一个独立 conversation，流式卡片输出（`pi.live` → 卡片 PATCH，1.5s 节流） |
| 崩溃续跑 | 模型请求/工具调用/压缩都是 durable task；进程被 `kill -9`，重启后从断点继续 |
| 长期记忆 | 两层：`global_memory`（跨 chat 共享）+ `chat_memory`（本对话）。`remember` / `forget` 工具，`/memory` 查看 |
| 主动性 | `remind` 工具创建 **durable 定时任务**：存 deadline 睡觉，进程重启后照样到点触发，主动发消息 |
| 工具审批 | `guard` hook 拦危险调用（`rm -rf`、`git push --force`、`sudo`、写工作区外…），发带按钮的卡片等人点，decision 存 memo |
| 成本闸门 | `pi.usage` 汇总 → 每日额度（`AGENT_DAILY_BUDGET_USD`），超了拒绝新请求，跨天自动重置 |
| 图片 | `image` 与 `post`（图文混排）都解析 → 下载 → base64 → 多模态模型；带锚定提示，先描述图再答题 |
| 卡片自愈 | 卡片 id 存进 durable `app.pending-cards`，进程重启后重新接管 submission 并把答案单独发出来；PATCH 失败自动降级为纯文本消息 |
| 命令 | `/help` `/new` `/stop` `/cost` `/memory` `/id` |
| 幂等 | `requestId = feishu:<message_id>`，飞书 at-least-once 重投不会问两遍 |

## 快速开始

```bash
cp .env.example .env     # FEISHU_APP_ID / SECRET / ALLOWED_* / AGENT_DAILY_BUDGET_USD
npm install
npm run typecheck
npm run ask -- "用一句话介绍你自己"      # 本地冒烟（不碰飞书）
./scripts/agentctl install              # launchd 常驻
./scripts/agentctl logs                 # 看日志
```

`npm run card -- oc_xxx` 可以单测卡片创建+原地更新。

### 飞书后台

1. 事件与回调 → 订阅方式选 **使用长连接接收事件**
2. 订阅 `im.message.receive_v1`、`card.action.trigger`（卡片按钮回调）
3. 权限：`im:message`、`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`
4. 创建版本 → 发布（不发布等于没配）

## 运维

```bash
./scripts/agentctl install|start|stop|restart|status|logs [n]
```

- 日志：`logs/agent.log`、`logs/agent.err.log`
- 出错会打 `[report] <kind>`（hook/tool/listener 的失败不会抛进 harness，只能在这看）
- `FEISHU_LOG_LEVEL=debug` 打印每条入站 ws 帧，用来区分"控制台没推"和"我们丢了"
- **一份 storage 只能一个进程写**：不要在 `main.ts` 跑着的时候再 `npm run ask`

## 结构

```
src/
  config.ts      .env 解析（优先级高于 shell，防止环境变量把 appId 顶掉）
  models.ts      provider 注册（magpie + 内置）
  personal.ts    人设 / 时间 / 工作区 section
  memory.ts      global + chat 两层记忆 doc、remember/forget、prompt section
  reminders.ts   durable Reminder task（sleepUntil）+ remind 工具
  approval.ts    guard hook：危险调用识别 + 审批
  budget.ts      每日花费 doc + 闸门
  channel.ts     扩展 → 宿主 的回调（notify / requestApproval / surface 映射）
  harness.ts     Harness.open、扩展装配、chat↔conversation 映射
  live.ts        订阅 pi.live，读出流式文本和当前工具
  cards.ts       durable 卡片登记：重启后接管未完成的提交
  log.ts         带时间戳的日志（launchd 文件日志需要时间线）
  feishu.ts      长连接、卡片流式、审批按钮、图片、命令、额度闸门
  main.ts        进程入口
  cli.ts         本地冒烟（stdin 审批、stdout 通知）
launchd/         plist
scripts/agentctl 启动/停止/日志
```

## 实测过的行为

| 场景 | 结果 |
|---|---|
| 本地提问 / 工具调用 | 1.8s 返回，写文件、读文件正常 |
| 重启后会话连续性 | conversation id 不变，历史与记忆都在 |
| `kill -9` 中途续跑 | `sleep 10` 被杀，新进程把工具调用标为中断，模型改后台重跑并答完，21s 收口 |
| 跨对话记忆 | 新 conversation 里直接答出"杭州 / 美式"（来自 global_memory，未用工具） |
| durable 提醒 | 设置 8s 提醒 → 到点主动发消息 |
| **提醒跨进程** | A 进程设 45s 提醒后退出，B 进程打开同一 storage，到点照样触发 |
| 工具审批 | `rm -rf /tmp/pd-guard-test` 被拦，目录完好，模型说明"等你批准" |
| launchd 自愈 | `kill -9` 后自动重启，WS 重连成功 |
| 图片端到端 | 飞书 `post` 图文消息 → 下载 60KB JPEG → 模型准确描述截图内容 |
| 卡片全链路 | `turn start → card created → submitted → settled 4.8s → answer read → final card patched` |

## 设计取舍

- **一个 chat = 一个 conversation**；话题（thread）暂未 fork，可用 `conversation.fork(entryId)` 扩展。
- **记忆选择性写入**：只记长期有用的事实，带日期；`global` 默认、`chat` 可选；`forget` 可按关键词删。不记流水账，避免记忆污染。
- **审批 fail closed**：没有审批通道（比如 CLI 非交互）时默认拒绝，不默认放行。
- **审批 decision 存 memo**：进程死掉重跑 hook 不会重复问你。
- **预算按天**：以 session 总花费做基线做差值，跨天重置；不做硬性的 per-request 熔断（避免打断正在跑的任务）。
- **不做子 agent**：需要时 tool 里 `tx.createConversation()` + `submit()` + `wait()` 即可，天然 durable。

## 排查手册

| 现象 | 看哪里 |
|---|---|
| 卡片停在"思考中" | `final card patch failed` + 飞书错误码；或 `unfinished card from previous process`（重启导致，已自动接管） |
| 收了图但答非所图 | 日志里 `type=post images=1`；模型侧问题就换视觉模型 |
| 消息没反应 | `ignored (原因)`：`chat-not-allowed` / `sender-not-allowed` / `group-message-without-mention` / `unsupported-message-type` |
| 连不上 | `ws reconnecting` / `ws connect failed`，飞书网关偶发握手失败会自动重连，断线期间事件不补发 |

## 已知限制

- Pi Durable 是 **experimental**，1.x 之间 API 会变，升级前先 `npm run typecheck`。
- SQLite 用 `synchronous=NORMAL`：进程崩不丢，掉电可能丢最后一个 commit。
- `bash` 理论上能 `cd` 出工作区；靠 guard hook 兜危险性，不是沙箱。要多租户就换远程 `ExecutionEnv`。
- 群里只响应 @，单聊全响应；白名单为空时谁都能用（启动会警告）。

## 下一步候选

- 群话题 fork（主对话 + 每 thread 一条子对话）
- 晨报/心跳：`afterRun` hook + durable 定时任务，按需推送而不是打扰
- 记忆检索：现在是全量注入最近 40 条，量大了要换关键词/向量检索
- 语音消息：飞书语音 → ASR → 文本
