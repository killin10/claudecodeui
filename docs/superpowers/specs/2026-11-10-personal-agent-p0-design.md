# Personal Agent P0：持久主体、记忆与自唤醒

## 1. 背景与目标

CloudCLI 已具备多 provider 会话、session-control 提交管线、定时任务、Browser Use、通知渠道等能力，但所有能力都围绕"一次次独立的会话"。Personal Agent 方向要求一个**长期存在、记得你、会自己醒来做事并在必要时找你**的主体。

P0 只建设这个主体的基座，让后续的 IM 入口（P1）、事件触发与目标台账（P2）都有落点。

### P0 交付后用户能做到

1. 在设置中配置一个 Personal Agent：provider、模型、权限模式、人设、心跳频率、时区、免打扰时段、预算。
2. Agent 按心跳周期**在全新会话中**醒来，读取记忆和待办，自行判断是否需要行动；无事则静默结束。
3. Agent 在运行中通过工具读写长期记忆、给自己预约后续跟进、向用户发送通知。
4. 用户在 UI 中查看运行时间线、通知收件箱、待触发列表、记忆文件；可一键暂停或终止。
5. 所有自主行为有审计记录，受预算和配额约束，不会无限自我续命。

### 非目标（明确不做）

- IM 渠道接入与聊天内按钮审批（P1）。
- 入站事件总线、外部连接器（邮件、GitHub、日历）（P2）。
- 目标台账与风险分级策略引擎（P2）。P0 仅使用 provider 原生权限模式加 Agent 级预算。
- 多用户隔离、公开访问。P0 每个 CloudCLI 用户最多一个 Agent（表结构允许多个）。
- OpenCode、Cursor 作为 Agent provider（见 §5.3，P0 只支持 Claude 与 Codex）。
- 向量检索。P0 记忆检索使用 SQLite FTS5。

## 2. 核心概念

| 概念 | 定义 |
|---|---|
| **Agent** | 持久主体。持有配置、主目录（home）、记忆、触发器、预算。状态为 `active` / `paused`。 |
| **Home** | `~/.cloudcli/agents/<agentId>/`，同时注册为该 Agent 的 project。所有唤醒会话的 cwd 都是它。 |
| **Wake（唤醒）** | Agent 的一次运行。每次唤醒都创建**新的 app session**，避免上下文无限累积。对应一行 `agent_runs`。 |
| **Trigger** | 唤醒来源：`heartbeat`（周期心跳）、`followup`（Agent 自己预约）、`manual`（用户点"立即唤醒"）。 |
| **Run token** | 每次唤醒签发的一次性凭据，Agent 通过它调用自控 MCP；运行结束即失效。 |
| **Inbox** | Agent 发给用户的通知存档，同时经现有通知渠道推送。 |

## 3. 总体架构

```
          ┌────────────── personal-agent module ───────────────┐
 heartbeat│  trigger dispatcher ──► wake service ──► budget guard│
 followup │        ▲                    │                       │
 manual ──┤        │            create session + submit         │
          │  agent_triggers             │ (session-control,     │
          │                             │  runtimeOptions 携带   │
          │                             │  extraMcpServers)     │
          │                             ▼                       │
          │                    provider runtime (Claude/Codex)  │
          │                             │ stdio                 │
          │                     cloudcli personal-agent-mcp     │
          │                             │ HTTP + run token      │
          │                             ▼                       │
          │   /api/personal-agent-mcp ─► memory / followup /    │
          │                              notify / run_info      │
          │                             │                       │
          │   run completion observer ─► agent_runs, journal,   │
          │                              idle 归档, home git 提交 │
          └─────────────────────────────────────────────────────┘
```

执行路径完全复用 session-control 的提交管线（排队、`waiting-for-input`、取消、运行注册表）。personal-agent 模块只负责"何时醒、带什么上下文、给什么工具、醒完记什么"。

## 4. Home 目录与记忆

### 4.1 目录布局

```
~/.cloudcli/agents/<agentId>/
  AGENTS.md            # 生成文件：人设 + 行为守则 + 工具使用约定（Codex/OpenCode 原生读取）
  CLAUDE.md            # 生成文件：内容为 "@AGENTS.md"（Claude 原生读取）
  memory/
    profile.md         # 关于用户：身份、偏好、红线。Agent 只读（见 4.3）
    facts/<slug>.md    # 稳定事实，一事一文件，带 frontmatter
    journal/YYYY-MM-DD.md  # 情节记忆：每次唤醒追加一段
  scratch/             # Agent 的工作区，可随意读写
  .git/                # 每次唤醒结束后自动提交，用于审计与回滚
```

- 人设与守则放在 `AGENTS.md` / `CLAUDE.md`，借助各 CLI 的原生机制注入，无需改造 provider 的 system prompt。
- 两个生成文件由 `agent-home.service` 根据 Agent 配置渲染。用户在 UI 中编辑的是配置里的 `persona` 字段，而不是直接改文件，这样升级守则模板时可以重新生成。

### 4.2 fact 文件格式

```markdown
---
title: 主力开发机
kind: fact            # fact | preference | person | project
source: run:<runId>   # 或 user
confidence: high      # high | medium | low
updated: 2026-11-10T09:00:00+08:00
---
树莓派 5，部署目录 ~/.local/share/cloudcli，systemd 托管。
```

### 4.3 写入规则

| 目标 | Agent 写入方式 | 说明 |
|---|---|---|
| `profile.md` | 不可写；只能通过 `notify_user(kind=profile_proposal)` 提议 | 用户在 UI 中确认后由服务端写入 |
| `facts/` | `memory_write` | 同 slug 覆盖，旧版本留在 git 历史 |
| `journal/` | 服务端在唤醒结束时追加摘要；Agent 可用 `memory_write(kind=journal)` 追加 | |
| `scratch/` | CLI 原生文件工具 | 不进入检索索引 |

Agent 具备 cwd 内的原生文件编辑能力，理论上可以绕过工具直接改 `profile.md`。P0 接受这种"软保护"：守则中明确禁止，每次唤醒后的 git 提交使篡改可见；如果 diff 中出现对 `profile.md` 的修改，服务端自动回滚并向 inbox 写一条警告。

### 4.4 检索

- 文件是唯一事实源；`agent_memory_fts`（FTS5）是派生索引，覆盖 `profile.md`、`facts/`、`journal/`。
- 启动时、`memory_write` 后、每次唤醒结束后，按 mtime 增量重建索引。
- 中文分词：FTS5 默认分词器不切中文。P0 使用 `trigram` 分词器（已验证：项目内的 better-sqlite3 内置 SQLite 3.53.2，可以检索中文子串），查询少于 3 个字符时退化为 `LIKE`。

### 4.5 唤醒时注入的记忆摘要

为控制唤醒开销，wake prompt 中只注入：

- `profile.md` 全文（上限 4 KB，超出部分截断并提示用 `memory_search`）；
- 最近 3 天 journal 的标题行；
- 待触发的 followup 列表（前 10 条）；
- 自上次唤醒以来未读、由用户回复的 inbox 条目（P0 中用户可在 UI 回复通知，见 §8）。

其余内容由 Agent 按需调用 `memory_search` 获取。

## 5. 唤醒（Wake）流程

### 5.1 时序

1. **触发**：dispatcher 每 15 秒轮询 `agent_triggers`，取出到期行；manual 触发直接调用。
2. **守卫**（任一不满足则在 `agent_runs` 记录 `skipped` 并说明原因）：
   - Agent 为 `active`；
   - 同一 Agent 没有进行中的运行（单 Agent 串行）；
   - 全局并发上限：同时进行中的 Agent 运行不超过 `PERSONAL_AGENT_MAX_CONCURRENT_RUNS`（默认 1，照顾树莓派）；
   - 预算未超（§9）；
   - followup 的链深度未超（§6.3）。
3. **建会话**：调用 session-control 的进程内接口创建 session，provider、model、权限模式取自 Agent 配置，project 为 Home，标题为 `[Agent] heartbeat · 11-10 09:00`。
4. **签发 run token**：32 字节随机数，`agent_runs` 中只存 SHA-256。
5. **组装 wake prompt**（§5.2）。
6. **提交**：调用 session-control 的进程内 `send`，`runtimeOptions.extraMcpServers` 中注入本次运行专属的 MCP 定义（§5.3）。
7. **观察完成**：订阅 submission 的终态（`completed` / `failed` / `cancelled`），以及 `waiting-for-input` 的转换（§5.4）。
8. **收尾**：
   - 读取最终 assistant 消息，判断是否为 idle；
   - 写入 `agent_runs`（状态、结局、摘要、耗时、token 用量，如可得）；
   - 追加 journal；令 token 失效；home 目录 `git commit`；
   - idle 运行的会话自动归档，避免侧边栏被心跳刷屏。

### 5.2 Wake prompt 模板

```
<agent-wake>
trigger: heartbeat | followup | manual
trigger_note: <followup 的 reason / manual 的附言>
now: 2026-11-10T09:00:00+08:00 (Asia/Shanghai)
run_id: <runId>
budget: runs_today=3/24, followups_active=2/20
</agent-wake>

<memory-digest>
...（§4.5）
</memory-digest>

<followup-task>   # 仅 followup 触发时出现
<Agent 当时写下的 prompt>
</followup-task>

按 AGENTS.md 中的守则执行。
若评估后无需任何行动，只回复一行：AGENT_IDLE
否则完成任务，并以一段不超过 5 行的"本次做了什么"作为结尾。
```

idle 判定：最终 assistant 文本去除空白后等于 `AGENT_IDLE`，且本次运行没有调用写类工具（`memory_write`、`notify_user`、`schedule_followup`）。

### 5.3 每次运行注入 MCP（关键改动）

Browser Use 当前把 MCP 注册在 user 作用域、用全局 token，对所有会话可见。personal-agent-mcp 需要识别"是哪次运行在调用"，因此改为**按运行注入**：

```jsonc
// runtimeOptions.extraMcpServers
{
  "cloudcli-agent": {
    "command": "<node>", "args": ["<dist>/personal-agent-mcp.js"],  // 解析方式同 browser-use getMcpCommand()
    "env": {
      "CLOUDCLI_AGENT_API_URL": "http://127.0.0.1:<port>/api/personal-agent-mcp",
      "CLOUDCLI_AGENT_RUN_TOKEN": "<明文 token，仅存在于子进程环境>"
    }
  }
}
```

| Provider | 注入点 | P0 |
|---|---|---|
| Claude | `claude-runtime.provider` 构建 `sdkOptions.mcpServers` 时合并 `options.extraMcpServers`（SDK 支持按 query 传入） | ✅ |
| Codex | app-server 为共享进程，环境变量无法按运行注入；改用 thread 启动时的配置覆盖 `mcp_servers`（`codex-app-server.client` 已有覆盖通道） | ✅ 需 spike 验证 |
| OpenCode | 共享 serve 进程，无按会话的 MCP 配置 | ❌ P0 不支持 |
| Cursor | 只能改全局配置文件 | ❌ P0 不支持 |

**Spike S1**：确认 Codex 能通过 thread 级配置覆盖新增 stdio MCP（而不仅仅是禁用已有 MCP），且 env 能传到 MCP 子进程。若不可行，Codex 降级为"在 wake prompt 中下发 run token，MCP 注册在 user 作用域、无 token 时拒绝"，并在文档中标注 token 会进入对话记录。

### 5.4 无人值守时的审批

Agent 运行若触发 provider 的权限审批，提交会进入 `waiting-for-input`，审批会出现在对应会话里。P0 的处理方式：

- 进入 `waiting-for-input` 时，以 `priority=high` 推送通知"Agent 需要你批准：<工具> <摘要>"，点击后跳转到该会话。
- 超过 `approvalTimeoutMinutes`（默认 30 分钟）仍无人处理：取消该次提交，结局记为 `cancelled:approval_timeout`，并写入 journal，下次唤醒时 Agent 可以看到。
- **Spike S2**：Claude runtime 中的 `CLAUDE_TOOL_APPROVAL_TIMEOUT_MS`（默认 55 秒）对 session-control 提交的行为——是超时拒绝后继续运行，还是转入 `waiting-for-input`。结论会决定上面的超时由哪一层负责。

推荐的默认权限模式：Claude 为 `default`（读操作放行，写入和 shell 需审批），Codex 为对应的保守模式。配置页对 `bypass-permissions` 给出显式风险提示。

## 6. 自控 MCP：`cloudcli personal-agent-mcp`

stdio MCP 进程只做协议转换：把每个工具调用以 `Authorization: Bearer <run token>` POST 到 `/api/personal-agent-mcp/tools/<name>`；所有校验和副作用都在服务端完成。

### 6.1 工具清单（P0）

| 工具 | 输入 | 行为与限制 |
|---|---|---|
| `memory_search` | `query`, `limit≤20`, `kinds?` | FTS 检索，返回路径、标题、片段、更新时间 |
| `memory_read` | `path` | 只能读 `memory/` 下的文件，单次上限 64 KB |
| `memory_write` | `kind: fact\|preference\|person\|project\|journal`, `slug?`, `title`, `content`, `confidence` | 写 `facts/` 或追加 journal；单文件上限 16 KB；每次运行最多 20 次写入 |
| `schedule_followup` | `runAt` 或 `cron`, `prompt`, `reason` | 见 §6.3 的配额 |
| `list_followups` | — | 当前 Agent 所有 active 的 followup |
| `cancel_followup` | `triggerId` | 只能取消 Agent 自己创建的 |
| `notify_user` | `title`, `body`, `priority: low\|normal\|high`, `kind: info\|question\|profile_proposal`, `proposal?` | 写 inbox，并按打扰策略推送（§8）；每次运行最多 3 条 |
| `run_info` | — | 返回 runId、触发源、预算余量、当前时间与时区 |

### 6.2 鉴权

- 服务端用 token 的哈希查 `agent_runs`；只有运行状态为 `running` 或 `waiting_for_input` 时有效。
- 每个 token 限速 60 次/分钟。
- 路由只接受 run token，不接受 UI session 或 API key，避免 MCP 通道成为通用后门。

### 6.3 防止无限自我续命

- 每个 Agent 同时 active 的 followup ≤ `maxActiveFollowups`（默认 20）。
- 一次性 followup 的 `runAt` 必须晚于现在 15 分钟以上、早于 30 天以内；Agent 创建的 cron 型 followup 最小间隔为 1 小时。
- **链深度**：由 followup 触发的运行再创建的 followup，`depth = 父 depth + 1`；heartbeat 与 manual 的 depth 为 0；`depth > 5` 时拒绝创建。
- 每日运行次数受 `maxRunsPerDay` 约束（§9）；被跳过的触发同样记录在案。

## 7. 数据模型

所有表随 `migrations.ts` 以 `CREATE TABLE IF NOT EXISTS` 方式新增，不修改现有表。

```sql
CREATE TABLE IF NOT EXISTS personal_agents (
  agent_id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'paused',          -- active | paused
  provider TEXT NOT NULL,                         -- claude | codex
  model TEXT,
  permission_mode TEXT NOT NULL DEFAULT 'default',
  persona TEXT NOT NULL DEFAULT '',
  home_path TEXT NOT NULL,
  timezone TEXT NOT NULL,
  quiet_hours TEXT,                               -- JSON {start:"22:30",end:"08:00"}
  budget TEXT NOT NULL,                           -- JSON，见 §9
  approval_timeout_minutes INTEGER NOT NULL DEFAULT 30,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agent_triggers (
  trigger_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES personal_agents(agent_id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                             -- heartbeat | followup
  created_by TEXT NOT NULL,                       -- user | run:<runId>
  cron TEXT, run_at TEXT,                         -- 二选一
  prompt TEXT, reason TEXT,
  depth INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'active',           -- active | paused | done | cancelled
  next_fire_at TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_triggers_due ON agent_triggers(state, next_fire_at);

CREATE TABLE IF NOT EXISTS agent_runs (
  run_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES personal_agents(agent_id) ON DELETE CASCADE,
  trigger_id TEXT,                                -- manual 时为空
  trigger_kind TEXT NOT NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  session_id TEXT REFERENCES sessions(session_id) ON DELETE SET NULL,
  submission_id TEXT,
  token_hash TEXT,
  status TEXT NOT NULL,                           -- skipped | running | waiting_for_input | completed | failed | cancelled
  outcome TEXT,                                   -- idle | acted | <skip/cancel 原因>
  summary TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0,
  usage TEXT,                                     -- JSON，provider 提供时填写
  started_at TEXT NOT NULL, finished_at TEXT
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_time ON agent_runs(agent_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_inbox (
  item_id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES personal_agents(agent_id) ON DELETE CASCADE,
  run_id TEXT,
  kind TEXT NOT NULL,                             -- info | question | profile_proposal | approval_needed | system_warning
  priority TEXT NOT NULL,
  title TEXT NOT NULL, body TEXT NOT NULL,
  proposal TEXT,                                  -- profile_proposal 的建议内容
  delivery TEXT NOT NULL DEFAULT 'pending',       -- pending | delivered | deferred | digest
  read_at TEXT, reply TEXT, replied_at TEXT,
  created_at TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
  agent_id UNINDEXED, path UNINDEXED, title, body, tokenize='trigram'
);
```

## 8. 主动触达与打扰策略

- `notify_user` 写入 `agent_inbox`，再根据策略决定是否推送：
  - **免打扰时段内**：`high` 立即推送，其余标记为 `deferred`，在时段结束时合并成一条摘要推送。
  - **免打扰时段外**：`high` / `normal` 立即推送，`low` 只进 inbox。
  - 每小时最多推送 `maxPushesPerHour` 条（默认 4），超出部分并入下一次摘要。
- 推送渠道：通过 notifications 模块新增的事件类型 `agent.notify` 复用 Web Push 与桌面通知。**webhook 渠道忽略该事件**，保持其"不携带内容"的既有约定。
- 回复：用户在 inbox 中可以对 `question` 写回复。回复会出现在下一次唤醒的 memory digest 中；`high` 优先级问题的回复还会立即触发一次 manual 唤醒。P1 的 IM 渠道复用同一个回复入口。
- `profile_proposal`：UI 展示 diff，用户点"接受"后由服务端写入 `profile.md` 并提交 git。

## 9. 预算、审计与一键停止

**budget JSON（默认值）**

```json
{
  "maxRunsPerDay": 24,
  "maxRunMinutes": 20,
  "maxActiveFollowups": 20,
  "maxPushesPerHour": 4,
  "pauseWhenPlanUsageAbove": 0.8
}
```

- `maxRunMinutes`：超时后通过 submission 取消接口终止运行，结局为 `cancelled:timeout`。
- `pauseWhenPlanUsageAbove`：若 provider 订阅用量服务（subscription-usage，当前在途开发中）可用，唤醒前检查用量比例，超过阈值则跳过，并在 inbox 写一条 `system_warning`（每天最多一条）。服务不可用时忽略此项。
- **审计**：`agent_runs` 记录完整时间线并链接到会话；home 目录每次运行后自动 git 提交，提交信息为 `run <runId> <trigger> <outcome>`；UI 可以查看单次运行改动了哪些记忆文件。
- **一键停止**：`POST /api/personal-agents/:id/stop` 会把 Agent 置为 `paused`，取消进行中的提交，并吊销 token。所有 Agent 创建的 followup 保持原状，恢复后按 misfire 策略 `skip` 处理期间错过的触发。

## 10. 模块与对现有代码的改动

### 10.1 新模块 `server/modules/personal-agent/`

（现有 `server/modules/agent/` 是外部 Agent API，名称不复用。）

```
personal-agent/
  index.ts                              # barrel：router 工厂、dispatcher 启停、MCP 入口
  personal-agent.routes.ts              # /api/personal-agents
  personal-agent-mcp.routes.ts          # /api/personal-agent-mcp（run token 鉴权）
  personal-agent-mcp.ts                 # stdio MCP 可执行入口
  services/
    agent-config.service.ts             # CRUD、校验、revision 乐观锁
    agent-home.service.ts               # 初始化 home、渲染 AGENTS.md/CLAUDE.md、git 提交、profile 防篡改
    agent-memory.service.ts             # 读写、FTS 索引、digest
    agent-trigger-dispatcher.ts         # 轮询、到期计算（复用 schedules 的 cron 计算）
    agent-wake.service.ts               # 守卫 → 建会话 → 提交 → 观察 → 收尾
    agent-run-token.service.ts
    agent-budget.service.ts
    agent-inbox.service.ts              # inbox、打扰策略、摘要
  tests/
```

数据库访问放在 `server/modules/database/repositories/personal-agents.db.ts`，与现有仓储风格一致。

### 10.2 对现有模块的最小改动

| 模块 | 改动 | 合并风险 |
|---|---|---|
| providers | 运行选项支持 `extraMcpServers`：Claude 合并进 `sdkOptions.mcpServers`；Codex 写入 thread 配置覆盖 | 中：上游频繁修改 runtime，改动收敛到一个合并函数内 |
| session-control | barrel 导出进程内的 `create` / `send`，`send` 接受内部 `runtimeOptions`（HTTP 层不开放） | 低 |
| schedules | barrel 导出 `schedule-timing` 中的 cron 计算函数 | 低 |
| notifications | 新增 `agent.notify` 事件；webhook 渠道显式忽略 | 低 |
| cli | 新增 `personal-agent-mcp` 子命令；可选新增 `cloudcli agent wake/pause/resume/runs` | 低 |
| database | 新增 §7 中的表 | 低 |
| server/index.ts | 挂载两组路由，启停 dispatcher | 低 |

### 10.3 HTTP API（`/api/personal-agents`，UI 会话鉴权与 session-control 的 API key 鉴权均可）

```
GET    /                          列表（P0 最多一个）
POST   /                          创建（初始化 home，默认 paused）
GET    /:id   PATCH /:id          查看 / 修改（携带 revision）
POST   /:id/activate | /:id/pause | /:id/stop | /:id/wake
GET    /:id/runs?cursor=          运行时间线
GET    /:id/triggers              DELETE /:id/triggers/:triggerId
GET    /:id/inbox?unread=         POST /:id/inbox/:itemId/read | /reply | /accept-proposal
GET    /:id/memory                GET /:id/memory/file?path=
```

### 10.4 前端（遵循 frontend-module-standards，新模块 `src/modules/personal-agent/`）

- 设置页中的 "Personal Agent" 配置表单：provider/model 复用现有选择器；人设使用多行编辑框；心跳 cron 复用 schedules 的预览组件。
- 侧边栏入口 "Agent"，内含四个标签页：时间线（runs）、收件箱（inbox，带未读角标）、待触发（triggers）、记忆（只读浏览，可在现有文件编辑器中打开）。
- 时间线中 `[Agent]` 会话可以点击跳转；idle 运行默认折叠。

## 11. 测试与验收

**单元测试（`server/modules/personal-agent/tests/`）**

- 守卫：并发、预算、paused、链深度、用量阈值各分支。
- followup 配额与时间窗口校验；cron 最小间隔。
- run token：哈希存储、状态失效、限速、跨 Agent 拒绝。
- idle 判定；journal 追加；`profile.md` 被修改后的自动回滚。
- 打扰策略：免打扰延后、每小时上限、摘要合并。
- FTS：中文 trigram 检索、短查询退化、按 mtime 增量重建。
- 路由解析与错误码。

**集成测试**：使用 fake provider runtime 跑通"heartbeat → 建会话 → MCP 调用 `memory_write` 与 `schedule_followup` → 完成 → followup 到期 → 第二次唤醒"整条链路。

**手工验收（树莓派真机）**

1. 配置 Claude Agent，心跳设为每 30 分钟，观察 24 小时：idle 运行全部自动归档，无残留进程。
2. 让 Agent "明早 9 点提醒我看 CI"：生成 followup，到点唤醒并推送通知。
3. 免打扰时段内的 normal 通知在时段结束后合并为一条推送。
4. 一键停止能在 5 秒内终止进行中的运行，之后 MCP 调用返回 401。
5. 手工修改 `profile.md` 的 Agent 运行被回滚，并产生警告。

## 12. Spike 与待定问题

| 编号 | 问题 | 影响 |
|---|---|---|
| S1 | Codex thread 级配置能否新增带 env 的 stdio MCP | 决定 Codex 能否在 P0 支持 |
| S2 | 无人值守提交下 Claude 审批超时的实际行为 | 决定 §5.4 的超时由哪一层负责 |
| S3 | ~~部署环境中 SQLite 是否支持 FTS5 `trigram`~~ | 已关闭：3.53.2 支持，中文子串检索正常 |
| S4 | 从提交结果可靠取得"最终 assistant 文本"与 token 用量 | idle 判定与预算准确性 |
| Q1 | 每次唤醒新开会话：是否需要"连续上下文"模式（例如同一天内复用会话）？ | P0 默认不复用，P1 再评估 |
| Q2 | idle 会话是只归档还是 N 天后永久删除 | 默认只归档，保留期作为配置项 |

## 13. 里程碑

| 里程碑 | 内容 | 估算 |
|---|---|---|
| M0 | Spike S1、S2、S4 | 2 天 |
| M1 | 表结构、配置 CRUD、home 初始化、manual 唤醒（新会话 + 收尾 + 归档 + git） | 4 天 |
| M2 | run token、`personal-agent-mcp`、记忆工具与 FTS、Claude 按运行注入 MCP | 4 天 |
| M3 | dispatcher、heartbeat/followup、配额、预算、一键停止、Codex 注入 | 4 天 |
| M4 | inbox、打扰策略、`agent.notify` 推送、前端四个标签页与配置页 | 5 天 |
| M5 | 集成测试、树莓派 24 小时验收、文档 | 2 天 |

合计约 3–4 周（单人）。每个里程碑独立可合并，M1 完成后即可手动使用。
