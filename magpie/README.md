# magpie agent plugin

让 Pi Durable Agent 出现在 magpie 的 Agent 页：在 magpie 里给它选模型，magpie 把模型、网关地址和
它自己的 key 写进本仓库的 `.env`；关掉开关，`.env` 恢复原样。

## 装

```bash
magpie plugin add ./magpie          # 在本仓库根目录
magpie ls                           # 应该出现 Pi Durable Agent
magpie pi-durable                   # 看它当前用的模型
magpie pi-durable vendor/deepseek-v4-pro   # 换模型（等于在 magpie 里点一下）
```

装完在 magpie 应用的「Agent」页也能看到这一行，选模型、切换都从那里面点。

## 它写什么

| `.env` 键 | 值 |
|---|---|
| `AGENT_MODEL` | magpie 的模型 id，就是 `<供应商>/<模型>` |
| `AGENT_PROVIDER` | `magpie` |
| `MAGPIE_BASE_URL` | 网关地址（`{v1}`，以 `/v1` 结尾） |
| `MAGPIE_API_KEY` | magpie 给这个 Agent 的 key |

只改这几个键，文件里其他内容（飞书凭据、注释、顺序）都保留；`magpie pi-durable default` 会把它们
还原成写之前的值。

## 重启才生效

Agent 在启动时读一次 `.env`，所以换完模型要重启进程：

```bash
./scripts/agentctl restart      # 或桌面端左栏底部的「重启」
```

## 路径不对的话

插件按 `PI_DURABLE_HOME`（默认 `~/learn/pi-durable-agent`）找 `.env`。仓库放在别处时，要么设
`PI_DURABLE_HOME`，要么改 `agent.js` 里那一行的默认值。

## 为什么这里没有别的

模型列表不由这个插件提供：Agent 启动时直接向网关的 `/v1/models` 要（上下文长度、模态、每 token
价格都在里面），所以 magpie 里新增的任何模型都不用改代码。路由组（`auto/*`、`group/*`）能用，但
Agent 会在日志里警告——同一个任务每次可能落到不同后端。
