# AgentAura Codex Plugin

将 Codex 的运行状态同步到 AgentAura ESP32 环形灯。插件基于 Codex hook 机制，把当前版本 Codex 实际支持的 hook 事件映射为固件文档中定义的 `agent <状态>` 指令。

## 状态映射

| Codex hook | AgentAura 状态 | 环形灯表现 |
| :--- | :--- | :--- |
| `SessionStart` | `init` | 初始化动画 |
| `PreToolUse` | `busy` | 黄色跑马，正在调用工具 |
| `PermissionRequest` | `waiting` | 黄色闪烁，等待审批 |
| `PostToolUse` | `running` | 绿色呼吸，工具结束后继续工作 |
| `PreCompact` | `busy` | 压缩上下文前忙碌 |
| `PostCompact` | `running` | 压缩完成后恢复运行 |
| `SubagentStart` | `busy` | 子代理开始工作 |
| `SubagentStop` | `running` | 子代理结束后恢复运行 |

这些状态与固件 [API 文档](../../Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/doc/API.md) 的 `agent running/busy/waiting/error/idle/init/offline/upgrade` 一致，无需修改固件。

## 功能

- 支持 HTTP、UDP、USB 串口三种传输方式。
- 支持 UDP 广播发现设备，并按当前 transport 补齐 host/port；不会自动把 UDP 配置改成 HTTP。
- 安装/卸载 Codex hooks 时会合并 `~/.codex/hooks.json`，保留其它插件 hook。
- 默认开启同步；关闭后 hook 会立即 no-op，不再向环形灯同步任何信号。
- Hook 命令永远吞掉异常，设备离线不会影响 Codex 主流程。
- 内置状态去抖、离线冷却和空闲超时回落，避免频繁重启灯效或长时间停留在运行态。

## 安装与配置

安装后可以直接在 Codex 里让它执行下面这些命令，或在普通终端执行；两者效果一样，因为配置写入的是 Codex 主目录下的配置文件。

```bash
cd Agent_Plugin/agent-aura-codex
npm install
npm run compile

# 创建默认配置文件，便于手动编辑
node out/index.js config init

# 推荐：连接本机 PetDesktop
node out/index.js configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false

# 或自动发现局域网设备并保存当前 transport 对应的连接信息
node out/index.js configure --discover

# 或手动配置 HTTP 固件
node out/index.js configure --transport http --host 192.168.1.100 --port 80

# 或手动配置 UDP
node out/index.js configure --transport udp --host 192.168.1.100 --port 8888

# 写入 Codex hooks
node out/index.js install-hooks

# 测试灯效
node out/index.js test busy
node out/index.js test waiting
node out/index.js test init

# 可选：调整空闲回落时间（毫秒），0 表示禁用
node out/index.js config set --idle-fallback-ms 5000
```

全局安装打包产物后可以直接使用：

```bash
agent-aura-codex config init
agent-aura-codex configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false
agent-aura-codex install-hooks
agent-aura-codex test busy
```

如果你正在 Codex 对话里配置，可以直接让 Codex 执行：

```text
运行：agent-aura-codex config init
运行：agent-aura-codex configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false
运行：agent-aura-codex install-hooks
运行：agent-aura-codex test busy
```

## 连接方式

### HTTP 推荐

本机 `PetDesktop`：

```bash
agent-aura-codex configure --transport http --host 127.0.0.1 --port 47831 --auto-discover false
```

HTTP 固件：

```bash
agent-aura-codex configure --transport http --host 192.168.1.100 --port 80
```

HTTP 模式会优先调用固件的 `POST /api/agent?state=<state>`，原始命令使用 `POST /api/cmd`。连接 `PetDesktop` 时会额外附带 `x-agentaura-*` 身份头，让桌宠能把 Codex 识别成独立 agent 实例。

### UDP

```bash
agent-aura-codex configure --transport udp --host 192.168.1.100 --port 8888
```

UDP 模式直接发送文本指令，例如 `agent busy\n`。

### USB 串口

```bash
agent-aura-codex configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
```

串口模式使用 USB CDC 文本指令，需要 `serialport` 可选依赖。

Linux 下可以先枚举当前设备：

```bash
ls -1 /dev/ttyACM* /dev/ttyUSB* 2>/dev/null || true
```

如果已经在插件目录内，也可以用 `serialport` 查看更完整的信息：

```bash
node -e "const {SerialPort}=require('serialport'); SerialPort.list().then(ports=>console.log(JSON.stringify(ports,null,2)))"
```

ESP32-C3 常见路径是 `/dev/ttyACM0`。如果测试时报串口权限不足，通常是当前用户不在 `dialout` 组：

```bash
sudo usermod -aG dialout "$USER"
```

执行后需要注销并重新登录，或重启当前终端会话。

## 常用命令

```bash
# 查看配置、hook 路径、最近发送状态
agent-aura-codex status

# 同时探测设备 /api/state
agent-aura-codex status --probe

# 扫描设备
agent-aura-codex discover

# 扫描并保存第一个设备
agent-aura-codex discover --save

# 发送固件文本指令
agent-aura-codex command "rgb 255,0,0"
agent-aura-codex command "effect rainbow"

# 暂停或恢复 hook 同步，不删除 hooks.json
agent-aura-codex disable
agent-aura-codex enable

# 同义别名
agent-aura-codex off
agent-aura-codex on

# 移除本插件写入的 Codex hooks
agent-aura-codex uninstall-hooks
```

配置文件默认写入 `~/.codex/agent-aura-codex.json`，Codex hook 文件默认是 `~/.codex/hooks.json`。

## 开关行为

插件默认开启，配置文件中的默认值是：

```json
{
    "enabled": true
}
```

临时关闭同步：

```bash
agent-aura-codex disable
```

这会创建 `~/.codex/agent-aura-codex.disabled`。之后 Codex hook 仍然存在，但每次触发都会立即跳过，不会发送任何状态到环形灯。

恢复同步：

```bash
agent-aura-codex enable
```

也可以通过配置文件长期关闭：

```json
{
    "enabled": false
}
```

或者用命令写入：

```bash
agent-aura-codex config set --enabled false
agent-aura-codex config set --enabled true
```

## 配置文件

查看配置文件路径：

```bash
agent-aura-codex config path
```

创建默认配置文件：

```bash
agent-aura-codex config init
```

强制重置为默认配置：

```bash
agent-aura-codex config init --force
```

配置文件内容示例见 [agent-aura-codex.config.example.json](agent-aura-codex.config.example.json)：

```json
{
    "enabled": true,
    "transport": "http",
    "host": "192.168.1.100",
    "port": 80,
    "serialPort": "",
    "baud": 115200,
    "debounceMs": 500,
    "cooldownMs": 3000,
    "timeoutMs": 650,
    "idleFallbackMs": 5000,
    "autoDiscover": true,
    "authToken": ""
}
```

### 认证 (authToken)

当固件开启了 HTTP 认证时，在配置中设置 `authToken`，插件会在所有 HTTP 请求中携带 `Authorization: Bearer <token>` 头。留空则不认证。UDP 和串口传输不携带 token。

```bash
agent-aura-codex config set --auth-token "your-secret-token"
```

清除 token：

```bash
agent-aura-codex config set --auth-token ""
```

也可以通过环境变量指定另一份配置文件：

```bash
AGENTAURA_CODEX_CONFIG=/path/to/agent-aura-codex.json agent-aura-codex status
```

## 环境变量

环境变量会覆盖配置文件，适合临时调试或多设备切换：

```bash
AGENTAURA_CODEX_TRANSPORT=http
AGENTAURA_CODEX_HOST=192.168.1.100
AGENTAURA_CODEX_PORT=80
AGENTAURA_CODEX_SERIAL_PORT=/dev/ttyACM0
AGENTAURA_CODEX_BAUD=115200
AGENTAURA_CODEX_ENABLED=true
AGENTAURA_CODEX_DEBOUNCE_MS=500
AGENTAURA_CODEX_COOLDOWN_MS=3000
AGENTAURA_CODEX_TIMEOUT_MS=650
AGENTAURA_CODEX_IDLE_FALLBACK_MS=5000
AGENTAURA_CODEX_AUTO_DISCOVER=true
AGENTAURA_CODEX_AUTH_TOKEN=your-secret-token
```

也兼容不带 `CODEX` 的通用变量，例如 `AGENTAURA_HOST`、`AGENTAURA_TRANSPORT`。

## 打包

```bash
# Linux / macOS
bash scripts/pack.sh

# 如果希望直接执行 ./scripts/pack.sh，先补执行权限
chmod +x scripts/pack.sh
./scripts/pack.sh
```

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1
```

脚本会生成：

- `dist/agent-aura-codex-<version>.tgz`：可用 `npm install -g` 安装。
- `dist/agent-aura-codex-<version>.zip`：源码 + 编译产物归档。

安装打包产物：

```bash
npm install -g dist/agent-aura-codex-0.1.0.tgz
agent-aura-codex configure --discover
agent-aura-codex install-hooks
```

如果使用 USB 串口而不是 WiFi，安装后改成：

```bash
agent-aura-codex configure --transport serial --serial-port /dev/ttyACM0 --baud 115200
agent-aura-codex test busy
agent-aura-codex install-hooks
```

安装 hooks 后，建议新开一个 Codex 会话或重启 Codex，让 Codex 重新读取 `~/.codex/hooks.json`。

## 关闭与移除插件

临时关闭同步，但保留 Codex hooks 和配置文件：

```bash
agent-aura-codex off
```

恢复同步：

```bash
agent-aura-codex on
```

长期关闭同步，可以写入配置文件：

```bash
agent-aura-codex config set --enabled false
```

只移除本插件写入的 Codex hooks，保留配置文件和命令本体：

```bash
agent-aura-codex uninstall-hooks
```

或者等价使用 hooks 子命令：

```bash
agent-aura-codex hooks uninstall
```

如果是全局 npm 安装，卸载命令本体：

```bash
npm uninstall -g agent-aura-codex
```

如果还想删除本插件配置和运行态缓存：

```bash
rm -f ~/.codex/agent-aura-codex.json
rm -f ~/.codex/agent-aura-codex-state.json
rm -f ~/.codex/agent-aura-codex.disabled
```

完整移除推荐顺序：

```bash
agent-aura-codex uninstall-hooks
npm uninstall -g agent-aura-codex
rm -f ~/.codex/agent-aura-codex.json ~/.codex/agent-aura-codex-state.json ~/.codex/agent-aura-codex.disabled
```


## Agent Skill

本仓库包含一个项目级 Agent skill：`.github/skills/agent-aura-codex/SKILL.md`。

当你在支持 skills 的 Agent 环境里询问 AgentAura Codex 的安装、配置、串口连接、hooks、开关或卸载流程时，Agent 可以自动加载这份 skill，并按仓库内已验证的命令执行。

常见触发说法：

- 配置 AgentAura Codex 串口连接
- 安装 AgentAura Codex hooks
- 关闭 AgentAura Codex 同步
- 移除 AgentAura Codex 插件
- 打包 AgentAura Codex 插件

## 目录结构

```text
agent-aura-codex/
├── package.json
├── tsconfig.json
├── src/
│   ├── config.ts        # 配置、运行态缓存、Codex hooks 路径
│   ├── deviceClient.ts  # HTTP / UDP / Serial 传输
│   ├── discovery.ts     # UDP 设备发现
│   ├── hooks.ts         # Codex hook -> AgentAura 状态映射
│   ├── installHooks.ts  # 合并安装 / 卸载 ~/.codex/hooks.json
│   ├── index.ts         # CLI 入口
│   └── types.ts
└── scripts/
    ├── pack.sh
    └── pack.ps1
```
