# Raspberry Pi 开发与部署

在树莓派上直接 clone 本仓库的 `develop` branch，安装依赖、开发、测试和部署。`npm run dev` 运行工作区代码，`npm run deploy:local` 构建并安装独立版本，服务管理命令与 macOS 相同。

目标环境是 Raspberry Pi 4B、64 位 Raspberry Pi OS（Debian 12/13）、Node 22/24 LTS 和 systemd 用户服务。建议使用 4 GB 或以上内存、SSD 和适量 swap；这是资源配置建议，尚未完成 Pi 实机性能测量。32 位系统、Alpine/musl 和容器内无 systemd 的环境不在此部署流程的支持范围内。

## 准备系统与源码

用普通用户 SSH 登录树莓派，确认系统和 Node 都是 64 位。不要用 root clone、安装 npm 依赖或运行 CloudCLI。

```bash
uname -m
# 预期 aarch64
sudo apt-get update
sudo apt-get install -y git curl ca-certificates build-essential python3 pkg-config tmux
sudo loginctl enable-linger "$USER"
loginctl show-user "$USER" --property=Linger
# 预期 Linger=yes
```

通过你使用的 Node 管理器安装 Node 24 LTS，例如已有 nvm 时执行 `nvm install 24 && nvm use 24`。不要依赖系统仓库可能提供的较旧 Node 版本。安装完成后确认：

```bash
node -p 'JSON.stringify({version:process.version, arch:process.arch, lts:process.release.lts})'
# arch 应为 arm64，版本应为 v22.x 或 v24.x 且 lts 非空
systemctl --user show-environment >/dev/null
```

```bash
mkdir -p ~/codespace
cd ~/codespace
git clone --branch develop --single-branch https://github.com/killin10/claudecodeui.git
cd claudecodeui
ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci
```

这里跳过的是 Electron 桌面程序下载，Web 开发和部署不需要它。不要从 Mac 复制 `node_modules`；SQLite、bcrypt、node-pty 等依赖必须在 Pi 上安装。没有可用预构建包时，安装过程会使用系统编译工具。

## 开发

在仓库根目录创建 `.env`。下面用单独数据库和端口，避免与已部署的 3001 服务争用：

```dotenv
HOST=127.0.0.1
SERVER_PORT=3002
VITE_PORT=5173
DATABASE_PATH=/home/pi/.cloudcli-dev/auth.db
```

将 `/home/pi` 替换为实际用户的 home 绝对路径。`.env` 不支持 `~` 或 `$HOME` 展开。修改已有 `.env` 时保留需要的配置，不要覆盖密钥。

```bash
mkdir -p ~/.cloudcli-dev
npm run dev
```

在自己的电脑另开终端建立 SSH 隧道，然后访问 <http://localhost:5173>：

```bash
ssh -N -L 5173:127.0.0.1:5173 -L 3002:127.0.0.1:3002 pi@raspberrypi.local
```

独立数据库只隔离 CloudCLI 的账号、会话索引和调度数据，provider 的原始会话、插件和 `~/.cloudcli` 下的其他文件仍可能共享。需要同时测试有副作用的任务、插件或调度时，使用独立 Linux 用户进行开发，或先停止部署服务。`deploy:local` 会重新执行 `npm ci` 并更新工作区构建目录，部署期间先退出开发进程。

开发阶段的验证命令：

```bash
npm run test:deploy
npm run typecheck
npm run lint
npm run build
npm run test -- --test-concurrency=1
npm run test:client -- --maxWorkers=1 --minWorkers=1
```

测试在开发阶段完成，上述命令限制了 ARM64 的测试并行度。部署只执行 typecheck、lint、build、原生模块检查和服务健康检查，不重复执行测试。若构建因内存耗尽退出，先检查 `free -h` 和系统 OOM 日志，配置适合机器容量的 swap，或减少同机任务；不要通过跳过检查掩盖失败。

## 首次部署

```bash
npm run deploy:local
```

它会构建当前 working tree，在 `~/.local/share/cloudcli/releases/` 安装独立版本，并检查 SQLite、bcrypt 和真实 PTY 操作。通过检查后才切换版本，服务由 `local.cloudcli.service` 管理。

首次安装只监听 `127.0.0.1:3001`。在自己的电脑建立隧道并访问 <http://localhost:3001> 创建账号：

```bash
ssh -N -L 3001:127.0.0.1:3001 pi@raspberrypi.local
```

完成账号初始化后，如需直接从局域网访问，在 Pi 的 `~/.config/cloudcli/server.env` 将 `HOST` 改为 `0.0.0.0`，然后执行：

```bash
~/.local/share/cloudcli/bin/cloudcli-service restart
~/.local/share/cloudcli/bin/cloudcli-service status
curl --fail http://127.0.0.1:3001/health
```

`~/.local/bin/cloudcli` 会安装为指向管理目录的链接。将 `~/.local/bin` 加入终端 PATH 后，就能使用会话和定时任务 CLI；服务管理仍使用 `cloudcli-service` 的上述绝对路径。服务默认不设置 `NODE_ENV=production`，与现有 Mac 部署保持一致。

## 更新与后台部署

从独立 SSH 终端更新工作区再部署：

```bash
cd ~/codespace/claudecodeui
git pull --ff-only origin develop
npm run deploy:local
```

如果有未提交修改，先处理它们；部署会构建当前 working tree。要让部署在 SSH 断开后继续，或在 CloudCLI 会话中触发部署，使用：

```bash
npm run deploy:local -- --background
```

Linux 上检测到命令来自 CloudCLI 自己的服务 cgroup 时，即使没传 `--background` 也会自动转为后台任务。安装器通过 `systemd-run --user --collect` 启动独立临时服务，避免停止 CloudCLI 时部署进程一起被杀。普通 `nohup` 无法脱离 systemd cgroup，不适合这种自部署场景。

命令返回“已提交”只代表后台任务启动，**不代表部署成功**。根据输出的路径查看 `status.json` 和 `deploy.log`，确认最终状态 `succeeded`，再检查 `cloudcli-service status`。临时 systemd unit 执行结束后自动清理，日志和结果文件保留在 `~/.local/state/cloudcli/logs/deploy-*/`。部署期间不要再次切换或修改该源码目录。

## 运行环境与验收

服务不会读取 `.bashrc`。Node 的绝对路径、版本和服务 PATH 保存在 `~/.config/cloudcli/service.json`，代理、CLI 显式路径和其他应用环境变量写入 `server.env`。不要移除该配置引用的 nvm 版本。Linux 默认使用 `C.UTF-8`，并提供 user bus 环境，使会话内的部署能够访问 systemd 用户服务。

安装器不会迁移 Mac 的登录凭据、provider 会话或插件。所用 Claude Code、Codex、OpenCode 等 provider 需要在 Pi 上具备相应 ARM64 可执行文件，并完成认证；只安装实际使用的 provider。浏览器功能还需要对应平台的浏览器运行时和系统依赖，服务健康检查不代表这些能力已就绪。

首次安装后验证：

1. Web 登录、一个 provider 的真实会话，以及 Terminal 输入输出。
2. 会话列表、消息发送、任务调度和实际需要的插件。
3. SSH 退出后服务继续运行，重启 Pi 后 `systemctl --user status local.cloudcli.service` 和 `/health` 正常。
4. 一次重新部署的状态为 `succeeded`，当前 release 和 `/health` 对应，失败时按日志排查。

通用目录、配置、回滚及数据库恢复规则见 [本机部署](local-deployment.md)。代码中的测试覆盖 Linux 服务控制协议和 macOS 回归，但不能替代 Pi 实机的 ARM64 依赖安装、systemd 生命周期和断电重启验收。
