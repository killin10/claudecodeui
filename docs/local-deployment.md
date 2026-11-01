# macOS 本机部署

从当前工作区构建，将产物安装到独立版本目录，由用户级 LaunchAgent 后台运行。服务不引用开发仓库的文件或 `node_modules`；移动仓库、切换分支不会改变已安装版本。

## 安装

在仓库目录执行：

```bash
npm run deploy:local
```

安装器优先使用已有 `service.json` 中的 Node；首次安装可使用当前 Node 22/24 LTS，或查找 Homebrew Node 24、`~/.nvm/versions/node/v24.*`。也可以明确指定：

```bash
npm run deploy:local -- --node /absolute/path/to/node
```

不会安装或修改全局 Node。锁定的 `better-sqlite3` 不支持 Node 26，因此部署会切换到找到的受支持 Node 后再安装依赖和构建。运行时固定可执行文件绝对路径与版本；不要删除相应的 nvm/Homebrew 版本。

安装依次执行：

1. 检查安装目录归属和配置，获得部署互斥锁。
2. 在工作区执行 `npm ci --include=dev`，设置 `HUSKY=0`，不改 Git hooks。
3. 执行部署测试、typecheck、lint、build，以及前后端测试。应用测试使用临时 HOME，避免写入本机应用数据。
4. 将产物复制到新 release，单独执行 `npm ci --omit=dev`，检查 SQLite、bcrypt 和实际 PTY 操作。
5. 停止本工具管理的旧服务，备份数据库，切换 `current`，加载 LaunchAgent。
6. 校验 launchd PID、应用 marker、`/health` 版本、首页和 JS 资源；成功后保留前一版本。

构建或依赖安装失败不会停止现有服务。构建输入是**当前工作区**，包括参与构建的未提交修改；元数据记录 commit、dirty 状态、文件状态列表、锁文件摘要和 Node 版本，但 dirty 构建不能仅凭 commit 复现。

### 已知上游 typecheck 问题

当前基线 `13e9ef6` 的 `src/modules/sidebar/tests/recentConversationTitleSync.test.ts:50` 缺少必填参数 `backgroundSessionIds`，会使 `npm run typecheck` 失败。部署脚本不修改业务代码。确认仍是这个既有问题时，可以显式执行：

```bash
npm run deploy:local -- --skip-typecheck
```

该参数**只跳过 typecheck**，仍执行构建、lint、部署测试和前后端测试，并在 `release.json` 记录例外。不要用它掩盖新引入的类型错误。

## 首次账号初始化与全地址监听

默认数据库不存在时，安装器为新配置使用 `HOST=127.0.0.1`，避免首次账号被其他机器抢先注册。可以显式使用 `--setup-local`，但它不会覆盖已有配置。

1. 打开 <http://localhost:3001>，由你自己创建账号。
2. 编辑 `~/.config/cloudcli/server.env`，把 `HOST=127.0.0.1` 改为 `HOST=0.0.0.0`。
3. 执行：

   ```bash
   ~/.local/share/cloudcli/bin/cloudcli-service restart
   ```

已有账号的安装可以直接使用 `0.0.0.0`。管理命令在开放监听前会检查账号是否已初始化。`0.0.0.0` 表示全部 IPv4 网卡，不意味着公网可达或 IPv6 双栈。公网访问应额外使用 VPN 或 HTTPS 反向代理；本工具不修改防火墙。

## 目录与配置

| 路径 | 用途 |
| --- | --- |
| `~/.local/share/cloudcli/releases/<id>` | 独立构建产物及生产依赖 |
| `~/.local/share/cloudcli/current` | 当前版本链接 |
| `~/.local/share/cloudcli/previous` | 前一个成功版本链接 |
| `~/.local/share/cloudcli/bin/cloudcli-service` | 与仓库无关的服务管理入口 |
| `~/.local/share/cloudcli/backups` | 部署前 SQLite 一致性备份 |
| `~/.local/share/cloudcli/run` | 操作锁和最近切换记录 |
| `~/.config/cloudcli/server.env` | 应用环境配置 |
| `~/.config/cloudcli/service.json` | Node 绝对路径、版本、服务 PATH |
| `~/Library/Logs/cloudcli` | 标准输出、错误日志 |
| `~/Library/LaunchAgents/local.cloudcli.plist` | 用户级 LaunchAgent |
| `~/.cloudcli` | 应用默认数据；部署不搬迁、不清空 |

`server.env` 示例（完成账号初始化后）：

```dotenv
HOST=0.0.0.0
SERVER_PORT=3001
# 默认数据库已经是用户目录下的 .cloudcli/auth.db，不需要重复设置。
# 如需自定义，必须使用绝对路径：
# DATABASE_PATH=/absolute/path/to/auth.db
```

配置使用项目现有的简单解析规则：`KEY=value`，不支持 shell 展开，也不去除引号。不要写 `DATABASE_PATH=~/.cloudcli/auth.db`、`$HOME/...` 或给值添加 shell 引号。文档与终端命令可以正常使用 `~`；安装器写入 plist、启动脚本的路径会自动转成绝对路径。

每个 release 的 `.env` 链接到固定 `server.env`。后续部署保留已有配置。两份配置文件初次创建时权限为 `0600`。

服务不读取 `.zshrc`，也不继承部署终端的所有环境变量；保留登录会话提供的 `SSH_AUTH_SOCK`，以便 Git 使用 SSH agent。需要的 CLI 目录写入 `service.json` 的 `path`；代理、显式 CLI 路径等写入 `server.env`。`HOME`、`PATH` 由服务配置控制。与默认 npx 启动一致，服务不主动设置 `NODE_ENV`；需要时可在 `server.env` 中显式配置。配置不会打包进 release，也不会输出到部署日志。

旧安装升级后会保留 `server.env`。若其中有旧部署生成的 `NODE_ENV=production`，需删除该行并重启服务，才能采用新的默认行为。设置为 `production` 会让插件安装时的 npm 默认跳过开发依赖，可能导致插件构建缺少 `tsc` 等工具。

## 服务管理

```bash
~/.local/share/cloudcli/bin/cloudcli-service status
~/.local/share/cloudcli/bin/cloudcli-service start
~/.local/share/cloudcli/bin/cloudcli-service stop
~/.local/share/cloudcli/bin/cloudcli-service restart
~/.local/share/cloudcli/bin/cloudcli-service enable
~/.local/share/cloudcli/bin/cloudcli-service disable
~/.local/share/cloudcli/bin/cloudcli-service logs
~/.local/share/cloudcli/bin/cloudcli-service releases
```

- `stop`：卸载当前 job，防止 KeepAlive 立即拉起；下次登录仍可自启。
- `disable`：停止服务并持久关闭登录自启。
- `start` / `enable`：启动服务并恢复自启；服务已运行时验证健康状态。
- `restart`：停止再启动，配置改动在此时生效。
- `logs`：显示末尾 100 行后持续跟随，按 Ctrl-C 退出。

LaunchAgent 在**用户登录后**启动，不保证注销后运行，也不阻止系统睡眠。启动命令直接运行编译后的后端，不运行 `npm start`、Vite 或构建命令。

发生版本更新或重启时，活动终端、WebSocket 和 agent 任务可能中断，建议先等待任务结束。

## 回滚与失败恢复

```bash
~/.local/share/cloudcli/bin/cloudcli-service rollback
# 或指定 releases 命令列出的 ID
~/.local/share/cloudcli/bin/cloudcli-service rollback <release-id>
```

回滚也会先停止服务并备份当前数据库。目标版本记录的数据库 schema 必须与当前数据库一致；schema 比对不证明所有数据语义兼容，因此跨业务迁移前仍需评估。

新版本启动失败时：

- 数据库 schema 未变化：尝试恢复旧代码并验证；**不恢复数据库**，不覆盖新数据。
- 数据库 schema 变化：停止服务，记录 `run/activation.json` 的 `manual-recovery-required` 状态，阻止下次登录自动运行失败版本，提示备份位置。
- 首次安装失败：停止服务并移除 `current`，保留 release 和数据供排查。

手工恢复流程：先 `disable`，检查 `activation.json` 和日志，选择兼容代码或经确认的数据库备份。恢复备份可能丢失备份之后的数据，必须单独决定；服务停止后再处理 SQLite 数据库及关联 WAL/SHM。确认完成恢复后，归档 `activation.json`，再执行显式回滚或重新部署。工具不会自动覆盖数据库备份。

若进程中断留下 `run/operation.lock`，读取其中 `owner.json` 的 PID，确认操作已不在运行后才手工删除锁。不要在另一个部署运行时强制解锁。

受控启动时，超过 10 MiB 的日志会轮转并保留 3 份；这不是持续的日志大小硬限制。保留最近 3 个成功版本，且不自动删除 `current`、`previous` 指向的版本。备份不随旧版本自动删除，需自行管理容量。

## 卸载

```bash
~/.local/share/cloudcli/bin/cloudcli-service uninstall --yes
```

删除 LaunchAgent、管理脚本、版本目录和版本链接。保留配置、日志、数据库备份以及 `~/.cloudcli` 和其他 CLI 的数据。卸载后仍保留安装归属标记，便于使用原配置重新安装。

## 验证与限制

```bash
~/.local/share/cloudcli/bin/cloudcli-service status
curl --fail http://127.0.0.1:3001/health
lsof -nP -iTCP:3001 -sTCP:LISTEN
launchctl print gui/$(id -u)/local.cloudcli
```

首次部署还应人工检查账号登录，以及所使用 provider 的一次实际调用。安装器的 PTY 检查证明终端原生模块可用，不等于所有 CLI 已认证。登录自启需要实际注销登录或重启后确认。

应用原有 Web/CLI 更新入口保持不变，仍可能安装上游 npm 包。**本安装的更新使用仓库里的 `npm run deploy:local`，不要使用应用自带的上游更新按钮。**
