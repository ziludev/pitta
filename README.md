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
| 长期记忆 | 三层：`global_memory`（跨 chat，注入最近 60 条）+ `chat_memory`（本对话，注入最近 20 条）+ `work_memory`（项目/环境细节，**不注入**，prompt 里只留一行索引，靠 `recall` 搜索）。`remember(scope)` / `forget` / `recall`，`/memory` 查看 |
| 主动性 | `remind` 工具创建 **durable 定时任务**：存 deadline 睡觉，进程重启后照样到点触发，主动发消息 |
| 工具审批 | `guard` hook 拦危险调用（`rm -rf`、`git push --force`、`sudo`、写工作区外…），发带按钮的卡片等人点，decision 存 memo |
| 用量统计 | 后台 durable 任务每 10 分钟采样一次累计 usage，按天存快照；请求日历接口时再即时采样一次，保证不用等 10 分钟。启动前的历史不计入（baseline） |
| 成本闸门 | `pi.usage` 汇总 → 每日额度（`AGENT_DAILY_BUDGET_USD`），超了拒绝新请求，跨天自动重置 |
| 多角色分工 | `delegate`（单个角色）/ `delegate_parallel`（并行）/ `build_feature`（设计→实现→测试流水线；`background="1"` 丢后台跑）。每个子 agent 都是 **task-owned conversation**：独立上下文、独立成本、崩了能续、abort 会级联，且只允许一层（子 agent 拿不到 delegate） |
| 角色 | `planner` 拆解 / `designer` 写设计文档 / `implementer` 实现 / `tester` 写测试 / `reviewer` 只读评审，各带独立指令与工具白名单 |
| 话题 / 回复 | 回复某条消息或话题群里的消息 → 在该消息处 `fork` 出一条独立 conversation，各自独立跑，互不阻塞 |
| 飞书原生 | `lark-cli`（已登录成你的身份）→ `feishu_agenda` 日历、`feishu_tasks` 待办、`feishu_create_task` 建任务（需审批）、`feishu_doc_read` 读文档 |
| 文件查看 | 改动面板点文件名 → 中间栏变成带行号的只读文件视图（`?file=` 可深链） |
| 输出规整 | 工具输出按形状渲染：JSON 高亮、日志按 ERROR/WARN/INFO 着色、TSV/表格转表格、其余原样 |
| 会话内查找 | 标题栏搜索框（⌘F 聚焦、Esc 清除、Enter/Shift+Enter 上下跳）：命中在当前会话内高亮（含行内代码），显示 `当前/总数`；`?q=` 可深链 |
| 跨会话搜索 | 左栏搜索框：即时过滤会话名，回车跑跨会话全文搜索，点结果跳到那条消息 |
| 评审意见 | 点 diff 行 → 写一句 → 收集成"评审意见" → 一次发给 agent（对齐 PR review 的回路） |
| 运行时间线 | 参考 Detent UI 的 Agent timeline：每个步骤一行 `工具 · 参数`，右侧是该步在整轮里的**迷你甘特条**（位置=起始时间，长度=耗时）与耗时；轮末一条**阶段占比条**（思考/工具/失败）+ 工具数 + token + 花费 + 总时长 |
| 思考折叠 | 一轮里的思考/工具调用收成一条「步骤轨」：`5 个步骤 · 思考 ×2 · recall, bash`，展开逐条看；轮末一条批次分隔线汇总 `3 次工具调用 🕐 5s` |
| 执行详情 | 有工具调用的轮次，卡片带「查看详情」按钮，点开看每步工具、输出摘要、耗时与花费 |
| Skills | 扫 `AGENT_SKILLS_DIRS`（默认 `./.pi/skills` → `~/.claude/skills` → `./workspace/skills`，前面优先）里的 `<name>/SKILL.md`：prompt 只放**分组后的名字**（71 个约 1KB），`skill(name)` 取全文 + 目录，`skill(query)` 按名字/描述搜。Claude Code / `npx skills add` 装的直接可用 |
| 工具生态 | `mcp.json` 里声明的 MCP servers（stdio / streamable HTTP）在启动时连接，工具以 `mcp__<server>__<tool>` 注册成 durable tool task；默认 `replay: unsafe`，被中断就报告模型而不是重放 |
| 进度反馈 | 流式文本 + 工具名；静默期间每 15s 心跳更新卡片（耗时 · 进行中）；结束给 `✅ 12.3s · 3 个工具 · $0.0021` |
| 语音 | `audio` 消息 → ffmpeg 转 16k wav → 本地 whisper 转写（中文），不需要 API key |
| 图片 | `image` 与 `post`（图文混排）都解析 → 下载 → base64 → 多模态模型；带锚定提示，先描述图再答题 |
| 卡片时间 | 正常轮次 `✅ 12.3s（20:01 起）`；重启恢复的提示与结果都带「开始于 HH:MM，已跑 Xm Ys」 |
| 卡片自愈 | 卡片 id 存进 durable `app.pending-cards`，进程重启后重新接管 submission 并把答案单独发出来；PATCH 失败自动降级为纯文本消息 |
| 命令 | `/help` `/new` `/stop` `/cost` `/memory` `/id` |
| 群聊 | 群里 @机器人 才响应；`FEISHU_ALLOWED_CHAT_IDS` 要包含群 id，`FEISHU_ALLOWED_SENDER_IDS` 决定谁能触发（群成员都能看到回复）。**新增群不用改配置**：拉进群后发 `/allow`（仅 owner）授权本群，或发 `/open` 开放给群里所有人（guest 模式）|
| guest 群 | `/open` 把群加进 `app.guest-chats` 并给该会话打 `app.chat-policy: {guest:true}`：**任何群成员**都能 @它，但 prompt 里**不注入 global_memory**、`remember` 只能写 chat 作用域、审批按钮仍只有 owner 能点 |
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

## 桌面客户端（MyGo）

`client/` 是一个 MyGo 桌面 app（Go 窗口 + 原生 WebView + React 前端），
和飞书是同一份 storage 上的**两个 watch 订阅者**。

前端栈：

| 用途 | 选型 |
|---|---|
| 组件 | shadcn/ui **Nova** 预设（`radix-nova`，Radix primitives + Tailwind v4 + CVA） |
| 图标 | Lucide |
| 动画 | Motion（`motion/react`） |
| 布局 | react-resizable-panels（三栏可拖拽分栏，尺寸记忆） |
| 拖拽 | dnd-kit（会话列表可拖拽排序，顺序持久化） |
| 状态 | Zustand（单一 store：会话/条目/live/记忆/改动/语言/连接状态） |

交互细节：会话可**拖拽排序**，拖到最顶或点图钉 = **置顶**（顺序与置顶都持久化）；
主题跟随系统（左上角按钮循环 system → light → dark）；提交说明用 Dialog；
`?theme=dark|light`、`?lang=zh|en`、`?entry=<id>` 三个 query 参数方便演示和截图。

```

```bash
cd client
bun install
bun run dev      # 开发：窗口 + 热更新（Vite 5173）
bun run build    # 产出 build/darwin-arm64/Agent.app + .dmg
```

它做的事：

- 左栏：会话列表（**客户端自建会话 / 飞书会话 / cli 测试**，按标题显示并按来源过滤，`+` 新建对话；每行 `⋯` 可**重命名 / 归档 / 清理工作区**，归档项默认隐藏）、运行中的后台任务、agent 状态与 重启/备份/日志 按钮、累计花费
- 中间：transcript 流式渲染（用户/助手/工具输出折叠/思考折叠/需求报告），`/new` `/stop`，插话（steer）开关
- 右栏：三个 tab —— **改动**（工作区 git diff，逐文件折叠、+/- 着色、一键提交、**合并回主线**）、**提交**（本会话分支相对主线的 commit 列表，展开看每个 commit 的 patch，可推送并拿到 PR/MR 链接）、**用量**（按日 token 方块图）与 **记忆**（全局/工作/本对话）
- **模型选择器**在输入框那一行（标题栏只留会话信息与查找），命令面板式（参考 ThinkRail）：搜索框（名称/provider/id）+ 最近使用 + 收藏（★）+ 按 provider 折叠分组（当前 provider 默认展开）+ 每个模型显示 `provider · 每百万 $in/$out · 上下文`；底部「力度」滑杆调 thinking level，还有「设为默认」（写 durable `app.default-model`，新会话生效）和「刷新」。切换只影响该会话（`configure({model})`）
- **token 方块图**（右栏「用量」tab）：GitHub 贡献图样式，17 周，按日总量着色；近 7/30 天与合计
- 中英切换（默认跟随系统语言，`?lang=zh|en` 可强制；选择记在 localStorage）

协议就是给客户端准备的：`src/server.ts` 暴露本机 `127.0.0.1:8787`

```
GET  /api/state                              会话（含来源 kind 与标题）/任务/花费
POST /api/conversations                      新建一个客户端会话（分配 worktree，surfaceId = client:xxx）
POST /api/surface-meta                       重命名 / 归档某个会话（按 conversationId 反查 surface）
POST /api/worktree/remove                    删除会话的 worktree（有未合并提交会拒绝，force 可强制；之后 cwd 回落到共享 workspace）
GET  /api/conversation?id=&limit=            历史条目
WS   /ws?conversationId=                     首帧 view + 之后每次提交的增量
POST /api/submit | /api/abort | /api/reset
GET  /api/memory?chat=  /api/tasks
GET  /api/changes      工作区 git status + unified diff（含未跟踪文件）
POST /api/commit       把工作区提交成一个 checkpoint
GET  /api/file?path=   读工作区文件（越界拒绝，512KB 上限）
GET  /api/search?q=    跨会话搜transcript（返回可读片段）
POST /api/merge        把会话分支 --no-ff 合并回主线（冲突返回数据，不猜）
GET  /api/models       可用模型（含价格/上下文/支持的思考级别）+ 宿主默认
POST /api/default-model 设置宿主默认模型（新会话用它）
POST /api/memory/curate 生成记忆建议（不写入）；POST /api/memory/apply 写入勾选的建议
POST /api/model        切某个会话的模型/思考级别
GET  /api/usage-calendar?days=  按日 token/花费方块图数据
```

**合并闭环**：改动面板右上角「合并」把 `agent/conv-N` 用 `--no-ff` 合回主线；未提交/主线脏会拒绝，
冲突则 `merge --abort` 回滚并把冲突文件返回，客户端可以一键「让 agent 解决」（agent 在自己的 worktree 里就地解）。

**每个会话一个 worktree**：新建会话时自动 `git worktree add` 到 `workspace/.worktrees/conv-<id>`、
分支 `agent/conv-<id>`，该会话的工具 cwd 就是这个目录。并行会话不再互相踩文件，主分支保持干净，
改动面板显示对应分支。`AGENT_WORKTREE=off` 可退回"所有会话共用一个 workspace"。

**工作区是个 git 仓库**：启动时如果 `workspace/` 没有 `.git` 就 `git init` + 初始提交
（`AGENT_WORKSPACE_GIT=off` 可关）。这样 agent 每次改文件都能在客户端里看到 diff、
可以回滚；如果 `AGENT_WORKSPACE` 指向已有的项目仓库，则直接用它的历史，不会重新初始化。

桥接跑在 agent 进程里（**一份 storage 一个写者**），客户端从不直接打开 SQLite。
`AGENT_HTTP_PORT=0` 可关掉桥接；`AGENT_HTTP_TOKEN` 非空时要求 `Authorization: Bearer`。

## 运维

```bash
./scripts/agentctl install          # 渲染 plist 并装载（开机自启 + 崩溃重启）
./scripts/agentctl install-backup   # 装载每天 04:10 的 sqlite 热备份
./scripts/agentctl start|stop|restart|status
./scripts/agentctl logs [n]         # agent 日志
./scripts/agentctl backup           # 立刻备份一次
./scripts/agentctl doctor           # 自检：node/git、.env、模型是否钉死、DB 完整性、写者锁、
                                    #       进程数、桥接端口、launchd 重启次数、workspace/worktree、最近错误
./scripts/agentctl backups          # 看快照
./scripts/agentctl restore <file>   # 用快照恢复（会先停 agent，等进程真正退出）
./scripts/agentctl uninstall        # 卸载两个 launchd job
```

plist 是模板（`launchd/*.plist.tmpl`），`install` 时把 `__PROJECT__` / `__NODE__` / `__HOME__`
渲染成实路径，所以换机器不用手改。node 路径在安装时从 `command -v node` 取，
换 node 版本后重跑一次 `install` 即可（`NODE_BIN=/path/to/node` 可覆盖）。

### 备份

`.data/agent.sqlite` 是唯一数据源（会话、记忆、提醒、卡片登记全在里面）。

- 每天 04:10 自动 `sqlite3 .backup`（WAL 热备，不用停 agent），备份后 `PRAGMA integrity_check` 校验，默认保留 14 份（`KEEP=30 ./scripts/backup-db` 可调）
- 快照会 `journal_mode=DELETE` 收成单文件，避免带上 `-wal/-shm`
- 恢复：`./scripts/agentctl restore backups/agent-YYYYMMDD-HHMMSS.sqlite`，会先备份当前库为 `.before-restore-*`

- 日志：`logs/agent.log`、`logs/agent.err.log`、`logs/backup.log`
- 出错会打 `[report] <kind>`（hook/tool/listener 的失败不会抛进 harness，只能在这看）
- `FEISHU_LOG_LEVEL=debug` 打印每条入站 ws 帧，用来区分"控制台没推"和"我们丢了"
- **一份 storage 只能一个进程写**：`openRuntime()` 会写 `.data/agent.owner`（pid），
  第二个进程直接报错 `storage … is owned by pid N`，而不是把运行中的会话搞坏（`AGENT_ALLOW_CONCURRENT=1` 可强制放行）

## 结构

```
src/
  config.ts      .env 解析（优先级高于 shell，防止环境变量把 appId 顶掉）
  models.ts      provider 注册（magpie + 内置）
  personal.ts    人设 / 时间 / 工作区 section
  memory.ts      global / chat / work 三层记忆 doc、remember/forget/recall、prompt section
  reminders.ts   durable Reminder task（sleepUntil）+ remind 工具
  approval.ts    guard hook：危险调用识别 + 审批
  budget.ts      每日花费 doc + 闸门
  channel.ts     扩展 → 宿主 的回调（notify / requestApproval / surface 映射）
  harness.ts     Harness.open、扩展装配、chat↔conversation 映射
  live.ts        订阅 pi.live，读出流式文本和当前工具
  cards.ts       durable 卡片登记：重启后接管未完成的提交
  threads.ts     消息 id → entry 索引 + thread → fork 出来的会话
  asr.ts         本地 whisper 转写（ffmpeg + whisper CLI）
  mcp.ts         MCP client：连 servers，把它们的工具注册成 durable 工具
  skills.ts      SKILL.md 发现（frontmatter 解析）+ skill 工具：按需取全文，不把描述全塞进 prompt
  server.ts      本机 HTTP+WS 桥：给桌面客户端订阅与提交
  lark-tools.ts  飞书原生工具（日历/待办/文档），走 lark-cli 的用户身份
  roles.ts       子 agent 角色：指令 + 工具白名单 + 轮次上限
  subagents.ts   delegate / delegate_parallel / build_feature（durable 子会话）
  details.ts     每轮工具调用明细，供「查看详情」按钮读取
  log.ts         带时间戳的日志（launchd 文件日志需要时间线）
  feishu.ts      长连接、卡片流式、审批按钮、图片、命令、额度闸门
  main.ts        进程入口
  cli.ts         本地冒烟（stdin 审批、stdout 通知）
launchd/         plist 模板（agent + 每日备份）
scripts/agentctl 安装/启动/停止/备份/恢复
scripts/backup-db sqlite 热备 + 完整性校验 + 轮转
scripts/import-hermes-memory.ts  从 ~/.hermes/memories 迁移记忆（支持 dry-run）
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

## 多角色分工

需求进来后可以让不同角色分头做，各自是独立的 durable conversation：

```
build_feature(spec, background="1")
   → 后台 durable task（app.feature）：designer → implementer → tester
   → 立即返回 taskId，父对话保持空闲，做完主动发飞书消息 + 写回父对话记录
build_feature(spec)    → 同步等待，适合 30 秒内的小活
delegate(role, task)   → 单个角色干一件事，返回它的结论
delegate_parallel(...) → 并行几个角色（例如 reviewer 评审 + tester 补测试）
task_status(id?)      → 列出/查看在跑的后台任务
cancel_task(id)       → 取消后台任务（级联停掉它的子 agent）
```

后台任务的保证：每个阶段的产出写进 task memo，崩溃后从**第一个未完成的阶段**续跑；
`/stop` 只中断当前轮次，不会杀掉后台任务；`agentctl restart` 之后照样继续。

为什么用 durable 的会话而不是"一次性 prompt"：

| 特性 | 效果 |
|---|---|
| task-owned conversation | 子 agent 的产出留在它自己的 transcript 里，可以回看、steer、重新 fork |
| `replay: "safe"` | 进程崩了重跑，找的是**同一个子会话**，不会重复开一份工作 |
| 归属级联 | 父调用被 abort（`/stop`），子 agent 一起停；它自己不会再派活（只允许一层） |
| 独立计费 | 每个子会话有自己的 `pi.usage`，成本可归因 |
| 崩溃续跑 | 子 agent 跑到一半挂了，重启后从它的断点继续，不用从头再来 |

实测（tiny feature，132s）：designer 26s 出设计文档 → implementer 写 `todo.py` 并自测 → tester 写 `test_todo.py`（33 个用例，`33 passed`），主 agent 汇总还顺手修了 tester 发现的一个裸 Traceback。

## 参考：JetBrains ThinkRail

ThinkRail 的定位和我们几乎一样（"a thin host that runs `pi` and bridges it to a rich UI"），
读了它仓库里的 `goal-and-requirements.md`，抄了三样、缓了三样。

已抄：

| ThinkRail 的做法 | 我们的落地 |
|---|---|
| **Review**：在文件/diff 上锚定评论，攒起来一次性交给 agent | 点 diff 行 → 收集 → "发给 agent"，把评论拼成一条评审消息 |
| **Workbench**：编辑器/差分/聊天在一个工作台里 | 改动列表点开即文件视图，中间栏在 transcript / 文件之间切换 |
| **Expose, don't recompute**：宿主只展示 pi 报告的东西 | 成本、工具调用、usage 全部读 `pi.live` / `pi.usage`，客户端不自己算 |

暂缓（成本高，等有需要再说）：

- **隔离 = git worktree**：它是"一个 workspace 一个 worktree、一条分支，主分支保持干净"；我们目前所有会话共用一个 workspace。要做的话是 per-conversation worktree + 分支，牵扯到工具 cwd 与合并流程。
- **Specs as ground truth**：意图沉淀成 spec 图供 agent 检索维护。我们现在靠 `global_memory` + `docs/`，够用但不结构化。
- **Open PR / 终端面板**：属于 IDE 化，收益不如上面几条直接。

## CLI

```bash
ln -sf "$PWD/bin/durable" ~/.local/bin/durable   # 放到 PATH
durable                 # 命令总览
durable setup           # 写 .env（App ID/Secret/白名单）并立刻体检
durable doctor          # 本地 + 飞书双侧体检
durable ask "…"         # 一次性提问（流式）
durable chat            # 交互式多轮（/new /stop /exit）
durable sessions        # 列出会话
durable approvals       # 待审批；durable approve <id> / deny <id>
```

命令名用 `durable` 而不是 `agent`：`agent` 已经被 grok 的 CLI 占用（`~/.grok/bin/agent`）。

对话类命令走**本机 HTTP/WS 桥**，所以 agent 正跑着（launchd 托管）时也能用，不需要停进程。

`durable doctor` 的飞书部分是把控制台最容易配错的地方读回来校验：凭证、机器人能力、
事件订阅方式是否长连接、在线版本是否含 `im.message.receive_v1`、卡片回调、消息 scope、
机器人是否已在群里。每一项失败都给一句「去哪儿点」。

### 关于「一键授权飞书」

飞书**自建应用**是租户级的：App ID/Secret 只能你自己在开发者后台创建，别人无法代劳
（跨租户要发布成 ISV 商店应用并过审）。所以 CLI 能自动化的是创建之后的一切——校验配置、
补齐缺失项、启动、诊断，而不是替你建应用。同租户的同事共用一个应用、各自跑实例是可行的；
跨租户只能各自建一个。

## 项目（project）

ThinkRail 的三层是 project → workspace → chats，我们补上了 project 这一层：

- **project** = 本机的一个 git 仓库（内置的 `workspace/` 是默认项目，删不掉）
- **chat** = 项目里的一个会话，自动 `git worktree add` 到 `<project>/.worktrees/conv-<id>`，分支 `agent/conv-<id>`
- 每个 chat 记住自己属于哪个项目（`app/conversation-project`），左栏按当前项目收窄，
  切换会话会自动跟着切项目
- 打开项目只接受**已存在的 git 仓库**，绝不替用户 `git init`；`.worktrees/` 写进仓库自己的
  `.git/info/exclude`，不污染 `git status`（不动用户的 `.gitignore`）

```
GET  /api/projects            已打开的项目
POST /api/projects            { path } 打开一个仓库（~ 可用）
GET  /api/git?conversationId= 本会话分支、基线（可选）、fork 点、commit 列表、本地分支、远端类型、PR/MR 链接
POST /api/git/base            { conversationId, base } 选比较/合并基线；换基线时提示 fork 点差异
GET  /api/git/diff?hash=      单个 commit 的 patch
POST /api/git/push            { conversationId, dryRun? } 推当前分支到 origin（dryRun 只报告）
POST /api/conversations       { projectId } 在该项目里新建会话
```

## 飞书原生工具

这些工具走本机已登录的 `lark-cli`（你的用户身份），不是在 bot 权限范围内扩权：

| 工具 | 作用 | 状态 |
|---|---|---|
| `feishu_tasks` | 我的待办 | ✅ 可用 |
| `feishu_agenda` | 日历日程 | ⚠️ 需要授权 `calendar:calendar.event:read` |
| `feishu_create_task` | 建待办（写，走审批） | ✅ 可用 |
| `feishu_doc_read` | 读云文档 | ✅ 可用 |

缺权限时授权（工具输出里也会带这条命令）：

```bash
lark-cli auth login --scope "calendar:calendar.event:read" --no-wait --json
# 打开返回的 verification_url 确认，再跑
lark-cli auth login --device-code <device_code>
```

## MCP（外接应用生态）

```bash
cp mcp.json.example mcp.json   # 改 servers
./scripts/agentctl restart
grep '\[mcp\]' logs/agent.log
```

支持 `command`（stdio，自动带 workspace 作为 cwd）和 `url`（streamable HTTP）。
连接失败的 server 只记日志，不影响其它 server 和 agent 启动。

## Skills（Claude Code 那套 SKILL.md）

`skills.ts` 给 harness 补了 skill 概念，因为 pi-durable 本身没有。用的是渐进式披露：

1. **prompt 里只有名字**：扫目录拿到 `name` + `description`（只解析 frontmatter 的前两个字段，自己写的迷你 YAML 解析器，支持 `>` / `|` 块标量），按 `family-*` 归组后列一行，71 个 skill 约 1KB。描述全塞进去要 5k+ token，每轮都付不划算。
2. **`skill(name)`** 返回 SKILL.md 全文（超过 14k 字符截断并给出路径）+ 目录，`scripts/`、`references/` 就在旁边，用 `bash` / `read` 继续取。
3. **`skill(query)`** 按名字（权重高）+ 描述（权重低）打分，返回前 10；不传参数列出全部。
4. 扫描结果缓存 30 秒，所以 `npx skills add` 装完不用重启。

```
AGENT_SKILLS_DIRS=./.pi/skills,~/.claude/skills,./workspace/skills   # 顺序即优先级
```

`~/.claude/skills` 里有 51 个是 cc-switch 的失效软链（指向不存在的 profile），跳过并在日志里报一次计数；直接 `skill("autoplan")` 时会明确说「目录在但 SKILL.md 读不到」，不会假装没这个 skill。

## 语音识别

`audio` 消息 → ffmpeg 转 16k mono wav → 本地 `whisper` CLI 转写。

```bash
brew install ffmpeg          # 已有
pip install -U openai-whisper
# 模型首次需要下载到 ~/.cache/whisper/（base 约 142MB）
```

请求路径里**不会**触发生效模型下载：模型文件不存在时直接回「whisper 模型还没下载好」，
避免把一次对话卡在几十分钟的下载上。想换模型或用别处的模型文件：

```bash
AGENT_ASR_MODEL=small AGENT_ASR_MODEL_PATH=/path/to/model.pt
```

`AGENT_ASR=off` 可整体关掉（此时语音消息会回一句"转写失败"并显示原因）。

## 排查手册

| 现象 | 看哪里 |
|---|---|
| 卡片停在"思考中" | `final card patch failed` + 飞书错误码；或 `unfinished card from previous process`（重启导致，已自动接管） |
| 收了图但答非所图 | 日志里 `type=post images=1`；模型侧问题就换视觉模型 |
| 消息没反应 | `ignored (原因)`：`chat-not-allowed` / `sender-not-allowed` / `group-message-without-mention` / `unsupported-message-type` |
| 连不上 | `ws reconnecting` / `ws connect failed`，飞书网关偶发握手失败会自动重连，断线期间事件不补发 |

## 已知限制

- **模型要钉死**：`auto/*`、`group/*` 是路由组，同一任务可能路由到不同模型，行为不稳定。
  默认已改成 `vendor/deepseek-flash`；用路由组时启动会打警告。
- Pi Durable 是 **experimental**，1.x 之间 API 会变，升级前先 `npm run typecheck`。
- SQLite 用 `synchronous=NORMAL`：进程崩不丢，掉电可能丢最后一个 commit。
- `bash` 理论上能 `cd` 出工作区；靠 guard hook 兜危险性，不是沙箱。要多租户就换远程 `ExecutionEnv`。
- 群里只响应 @，单聊全响应；白名单为空时谁都能用（启动会警告）。

## 下一步候选

- 群话题 fork（主对话 + 每 thread 一条子对话）
- 晨报/心跳：`afterRun` hook + durable 定时任务，按需推送而不是打扰
- 记忆检索：现在是全量注入最近 40 条，量大了要换关键词/向量检索
- 语音消息：飞书语音 → ASR → 文本
