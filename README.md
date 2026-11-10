# pi-durable-agent

跑在 [Pi Durable](https://earendil.com/posts/pi-durable/) 上的个人助理：飞书里聊、桌面上看、终端里也能用，进程挂了不丢对话。

- **引擎**：`@earendil-works/pi-durable` 1.5.0。每个模型请求、每次工具调用、每次压缩都是一个 durable task，每步先落 checkpoint；进程被 `kill -9`，重启后从断点继续。
- **模型**：`@earendil-works/pi-ai`。默认走本机 magpie 代理（OpenAI 兼容），可换任意内置 provider；模型/思考级别可**逐会话**切换。
- **存储**：SQLite（`.data/agent.sqlite`），单进程独占，重启原样恢复。
- **三个入口**：
  - 飞书自建应用（长连接，不需要公网 IP / 域名 / 证书）
  - `client/`：MyGo 桌面 app（Go 窗口 + React + shadcn/ui Nova）
  - `durable`：CLI

```
飞书 bot ─┐
桌面 app ─┼─→ agent 进程（一份 SQLite，唯一写者）─→ 127.0.0.1:8787 HTTP/WS 桥
CLI      ─┘
```

---

## 能力

### 对话

| | |
|---|---|
| 飞书 | 群/单聊各自一个 conversation；群里 @ 才响应；话题里追问 → 该话题独立 fork |
| 客户端 | 自建会话（每个自动分配 git worktree）、流式渲染、步骤时间线（见下） |
| CLI | `durable ask "…"` / `durable chat`（REPL）、`durable sessions` |
| 输入 | 文字、图片（飞书 image/post 消息；客户端粘贴截图）、语音（本地 whisper） |
| 中断 | `/stop`、客户端停止按钮；后台任务不受影响 |

### 运行时间线（参考 Detent UI / ThinkRail 的表达）

一轮回复被拆成可读的步骤，而不是一坨日志：

```
▸ 4 个步骤 · 思考 ×1 · 3 次工具调用
  ▸ ● bash · cd ~/work/service-cli && timeout 90 node dist   ▬▬▬▬───   8.50s
  ▸ ● bash · python3 - <<'EOF' import json,re …                  ▬──────   2.07s
  ▸ ● 思考                                                          ─────     —

──── ▬▬▬▬▬▬▬▬  ⚙ 3 次工具调用  # 185.7k  💰 $0.0281  🕐 171s ────
        ↑ 阶段占比：等你确认（琥珀）/ 思考（蓝）/ 工具（灰）/ 失败（红）
```

- 每步 = `工具 · 第一个有意义的参数`，右侧是该步在整轮里的**迷你甘特条**（位置=起始时间，长度=耗时）
- 轮末是阶段占比条 + 工具数 + token + 花费 + 总时长
- 「等你确认」的审批等待也会计入（数据来自 `app/approval-waits`），所以"这轮为什么 171 秒"能一眼归因

### 会话与项目

- **project** = 本机一个 git 仓库（内置 `workspace/` 是默认项目，删不掉）；ThinkRail 的 project → workspace → chats
- **chat** = 项目里的一个会话，自动 `git worktree add` 到 `<project>/.worktrees/conv-<id>`，分支 `agent/conv-<id>`
- 每个会话记录 **fork 点**和**当前基线**，基线可改（换成别的分支会提示"会把它上面的提交也算进来"）
- 会话可重命名 / 归档 / 清理 worktree（有未合并提交时拒绝清理）

### 代码

| | |
|---|---|
| 改动面板 | 工作区 diff，逐文件折叠、+/− 着色、一键提交、`--no-ff` 合并回基线 |
| 提交面板 | 本会话分支相对基线的 commit 列表，展开看 patch，推送后给出 PR/MR 链接（GitHub compare / GitLab MR） |
| 文件视图 | 点文件名 → 带行号的只读视图 |
| 评审回路 | 点 diff 行留意见 → 收集 → 一次性发给 agent |
| 工具输出 | 按形状渲染：JSON 高亮、日志按级别着色、TSV/表格成表、diff 走 diff 视图 |

`workspace/` 及每个 project 的 `.worktrees/` 都写进仓库自己的 `.git/info/exclude`，不污染 `git status`，也不动用户的 `.gitignore`。

### 记忆

三层，作用域决定是否进入 prompt：

| 层 | 内容 | 注入 |
|---|---|---|
| `global_memory` | 关于你的稳定事实、偏好 | ✅ 最近 60 条 |
| `chat_memory` | 当前对话的上下文事实 | ✅ 最近 20 条 |
| `work_memory` | 项目/环境细节 | ❌ 只留一行索引，靠 `recall` 搜 |

- 工具：`remember(scope)` / `forget` / `recall`
- **手动整理**：右栏「记忆 → 整理 24h」读最近会话，只产出**建议**（带 scope + 理由），你勾选后才写入；`global` 每次最多 3 条
- 删除过的记忆进 `app/memory-tombstones`，不会被模型"复活"；去重用字符 bigram 相似度（换说法也能识别）

### 安全与成本

- **审批**：`guard` hook 拦危险调用（`rm -rf`、`git push --force`、`sudo`、写工作区外…），发带按钮的卡片；decision 存 durable memo，重启不重问
- **同一份待审批**同时出现在飞书卡片和客户端（底部琥珀条），任一处都可决定；**fail closed**（没有审批通道时默认拒绝）
- **审批等待**会记录时长并计入该轮时间线
- **额度**：`pi.usage` 汇总 → 每日上限（`AGENT_DAILY_BUDGET_USD`），超了拒绝新请求，跨天重置
- **guest 群**：`/open` 把群开放给所有成员，但该会话**不注入 global_memory**、`remember` 只能写 chat 作用域
- **陌生人不会被静默丢掉**：白名单之外的消息不会回对方，但会给你发卡片（来源、会话 id、发送者 open_id、前 200 字）：
  - 会话不在名单 → 「授权此会话」（写 `app.allowed-chats`）
  - 会话在、但发送者不在 `FEISHU_ALLOWED_SENDER_IDS` → 「允许此人使用（guest 权限）」（写 `app.allowed-senders`，并把该会话设为 guest：不注入你的记忆、不写记忆、只读工具，同时回对方一句"已开通"）
  - 你自己的 p2p 会话 id 是第一次发消息时记下的（`app.owner-chat`），因为陌生人的会话 id 事先不可能知道

### 主动性

- `remind` 工具创建 **durable 定时任务**：deadline 落库、任务睡觉、重启后照样到点触发
- 左栏「运行中」显示后台任务 + 红黄绿状态点 + 触发时刻（`● 伸个懒腰 12:15`）
- 客户端窗口在后台时，一轮回答结束发原生通知

### 扩展

| | |
|---|---|
| Skills | 扫描 `./.pi/skills`、`./.agents/skills`、`~/.pi/agent/skills`、`~/.agents/skills`、`~/.claude/skills`（与 pi 一致，另加 Claude Code 目录）。prompt 只放名字，`skill` 工具按需取全文 |
| MCP | `mcp.json` 里的 servers（stdio / streamable HTTP）启动时连接，工具注册为 `mcp__<server>__<tool>` |
| 多角色 | `delegate` / `delegate_parallel` / `build_feature`；每个子 agent 是 task-owned conversation，崩了续跑、abort 级联、只允许一层 |
| 飞书原生 | 走本机已登录的 `lark-cli`（你的用户身份）：`feishu_agenda` 日历、`feishu_tasks` 待办、`feishu_create_task`、`feishu_doc_read` |

---

## 快速开始

```bash
cp .env.example .env          # 至少填 FEISHU_APP_ID / FEISHU_APP_SECRET
npm install
npm run typecheck
npm test                      # 纯逻辑单测（node --test）

durable doctor                # 本地 + 飞书双侧体检（推荐先跑）
durable setup                 # 或者交互式写 .env 并立刻体检

npm start                     # 前台跑一次试试
./scripts/agentctl install    # 交给 launchd 常驻（开机自启 + 崩溃重启）
./scripts/agentctl logs
```

### 飞书后台要开的

1. 事件与回调 → 订阅方式选 **使用长连接接收事件**
2. 订阅事件 `im.message.receive_v1`，回调 `card.action.trigger`（审批按钮）
3. 权限：`im:message`、`im:message:send_as_bot`、`im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`
4. 创建版本 → 发布（不发布等于没配）

`durable doctor` 会把上面每一项读回来校验，缺什么、去哪儿点，都直接说。

### 桌面客户端

```bash
cd client
npm install
npm run dev      # 开发：Go 窗口 + Vite 热更新
npm run build    # 产出 build/darwin-arm64/Agent.app 与 .dmg
```

前端栈：shadcn/ui **Nova**（`radix-nova`）+ Tailwind v4 · Lucide 图标 · Motion 动效 · react-resizable-panels 三栏 · dnd-kit 会话排序 · Zustand 状态 · next-themes 主题。

---

## CLI

```bash
ln -sf "$PWD/bin/durable" ~/.local/bin/durable   # 放到 PATH

durable                 # 命令总览
durable setup           # 写 .env（App ID/Secret/白名单）并体检
durable doctor          # 本地 + 飞书双侧体检
durable ask "…"         # 一次性提问（流式）
durable chat            # 多轮 REPL（/new /stop /exit）
durable sessions        # 会话列表（id / 来源 / 项目 / 标题）
durable approvals       # 待审批；durable approve <id> / deny <id>
```

命令名是 `durable` 而不是 `agent`：`agent` 已被 grok 的 CLI 占用。

对话类命令走**本机 HTTP/WS 桥**，所以 launchd 托管着 agent 时也能用，不需要停进程。

**关于「一键授权飞书」**：飞书自建应用是租户级的，App ID/Secret 只能本人在自己租户的开发者后台创建（跨租户要发布成 ISV 商店应用并过审）。所以 CLI 自动化的是创建之后的一切——写配置、校验每个开关、启动、诊断。同租户的同事可以共用一个应用、各自跑实例。

---

## 运维

```bash
./scripts/agentctl install          # 渲染 plist 并装载（开机自启 + 崩溃重启）
./scripts/agentctl install-backup   # 每天 04:10 的 sqlite 热备份
./scripts/agentctl start|stop|restart|status
./scripts/agentctl logs [n]
./scripts/agentctl doctor           # 本地自检（node/git、.env、DB、写者锁、进程数、端口、launchd 重启次数、worktree）
./scripts/agentctl backup|backups|restore <file>
./scripts/agentctl uninstall
```

- plist 是模板（`launchd/*.plist.tmpl`），`install` 时渲染实路径，换机器不用手改
- 备份：`sqlite3 .backup` 热备 → `journal_mode=DELETE` 收成单文件 → 完整性校验 → 保留 14 份；恢复会先停进程、等它真正退出
- **一份 storage 只能一个进程写**：`openRuntime()` 会写 `.data/agent.owner`（pid），第二个进程直接报错而不是把运行中的会话搞坏
- 日志：`logs/agent.log`、`logs/agent.err.log`、`logs/backup.log`；`[report] <时间戳> <kind>` 是 hook/tool/listener 的失败（不会抛进 harness，只能在这看）
- `doctor` 的判据是**相对量**：重启次数与上次体检比（`+N since last check`），错误只看近两天；旧日志里没有时间戳的行单独计数，不会永远冒充"新故障"

---

## 结构

```
src/
  main.ts          进程入口（bridge + 飞书 + 优雅退出；harness 失败即退出让 launchd 重启）
  server.ts        本机 HTTP/WS 桥：客户端和 CLI 的唯一入口
  harness.ts       Harness.open、扩展装配、chat↔conversation 映射、project/base 解析
  feishu.ts        长连接、卡片流式、审批按钮、图片/语音、命令、额度闸门
  cli/main.ts      `durable` 子命令；cli/feishu-check.ts 是飞书侧体检
  personal.ts      人设 / 时间 / 工作区 section
  roles.ts         子 agent 角色：指令 + 工具白名单 + 轮次上限
  subagents.ts     delegate / delegate_parallel / build_feature（durable 子会话）
  memory.ts        global / chat / work 三层记忆 doc、remember/forget/recall
  curator.ts       手动整理：读会话 → 只产出建议
  reminders.ts     durable Reminder task（sleepUntil）+ remind 工具
  approval.ts      guard hook：危险调用识别 + 审批
  approvals.ts     审批注册表（飞书卡片与客户端共用）
  budget.ts        每日花费 doc + 闸门
  usage-days.ts    按日 usage 采样（后台 durable 任务）+ 方块图数据
  projects.ts      project 列表、会话↔项目/基线绑定
  worktree.ts      每会话一个 git worktree/分支；merge 回基线
  git-info.ts      commit 列表、单 commit patch、push、PR/MR 链接
  changes.ts       工作区 status + unified diff + 提交
  skills.ts        SKILL.md 扫描（名进 prompt，全文按需取）
  mcp.ts           MCP client，把 server 的工具注册成 durable 工具
  lark-tools.ts    飞书原生工具（走 lark-cli 用户身份）
  asr.ts           本地 whisper 转写（ffmpeg + whisper）
  guest.ts / allowed.ts / surface-meta.ts / threads.ts / cards.ts / details.ts
  live.ts / log.ts / similar.ts / channel.ts / runtime-ref.ts / storage-lock.ts / models.ts

client/            MyGo 桌面 app
  main.go          Go 窗口 + 绑定（桥接地址/token、agentctl 控制、原生通知）
  src/components/  Transcript / TurnRail（步骤时间线）/ Composer / SideRail / SidePanel（改动·提交·用量·记忆）…
  src/store.ts     Zustand：会话/条目/live/记忆/改动/审批/项目/语言
```

---

## 实测过的行为

| 场景 | 结果 |
|---|---|
| 崩溃续跑 | `sleep 10` 跑到一半 `kill -9`，新进程把工具调用标为中断，模型改后台重跑并答完 |
| 跨进程提醒 | A 进程设 45s 提醒后退出，B 进程打开同一 storage，到点照样触发 |
| 重启保持 | conversation id、记忆、会话↔项目映射、会话↔卡片登记都不变 |
| 工具审批 | `rm -rf` 被拦 → 飞书卡片点「允许」/ 客户端 API 允许 → 工具真实执行；等待时长计入时间线 |
| worktree 隔离 | 会话 A 写文件，主树与其他会话看不到；合并 `--no-ff` 后出现在主树 |
| 未合并保护 | 清理 worktree 时分支有未合并提交 → `unmerged, commits:1` 拒绝 |
| 图片 | 飞书 `post` 图文消息 → 下载 60KB JPEG → 模型准确描述截图内容 |
| 子 agent | designer → implementer → tester 全跑通，`33 passed`；子会话独立计费、崩了续跑 |
| 存储写者锁 | 第二个进程 `openRuntime()` 直接报 `storage … is owned by pid N` |

---

## 已知限制

- 测试覆盖的是纯逻辑（记忆去重、审批注册表、diff 采集、远端链接），不是端到端；`npm test` 秒级
- Pi Durable 是 **experimental**，1.x 之间 API 会变；升级前先 `npm run typecheck`
- SQLite 用 `synchronous=NORMAL`：进程崩不丢，掉电可能丢最后一个 commit
- `bash` 理论上能 `cd` 出工作区；靠 guard hook 兜危险性，不是沙箱
- 跨租户"一键装飞书"做不到（见上文 CLI 一节）
- 方块图从采样器启动那天开始积累，更早的历史没有逐日数据

---

## 下一步候选

- ~~空转成本~~：量过了，`/api/state` 10–20ms / 21 个会话，占空比 0.1%，不是瓶颈
- 会话级耗时趋势（成本已到会话，时长还只有按轮）
- 主动性：邮件/日历/GitHub 事件触发（当前是你的显式指令 + 定时提醒）
- 记忆检索换关键词/向量（现在只有 bigram 去重 + recall 关键词）
