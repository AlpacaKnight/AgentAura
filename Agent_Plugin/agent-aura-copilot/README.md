# AgentAura - Copilot Ring Light

将 GitHub Copilot 的工作状态实时同步到 PetDesktop 桌宠或 ESP32 硬件，让你在桌面与物理设备上看到 AI 的活动状态。

HTTP 模式会自动识别目标：PetDesktop 使用 `/api/v1/agents/*` 完成注册、10 秒心跳、状态、气泡与断开注销；ESP32 固件继续使用 `/api/agent` 和 `/api/cmd`。UDP 发现会探测所有 IPv4 网卡，兼容同时安装虚拟网卡、VPN 与 Wi-Fi 的环境。

## 功能特性

### 🔄 自动状态同步

插件通过监控 GitHub Copilot Chat 的会话日志（transcript），实时感知 **Copilot 自身**的工作状态并映射到硬件灯效。它只跟踪 Copilot 的活动，**不会**监控你的代码编辑或按键行为。

| Copilot 状态 | 硬件状态 | 灯效 |
|---|---|---|
| 推理 / 生成回复 | `running` | 🟢 绿色呼吸 |
| 工具执行中（`run_in_terminal`、文件写入等） | `busy` | 🟡 黄色跑马灯 |
| 等待用户审批（确认工具调用） | `waiting` | 🟡 黄色闪烁 |
| 回复完成 | `idle` | 🔵 蓝色呼吸 |
| 插件启动 | `init` | 🌈 彩虹 (3秒后自动关灯) |
| 插件关闭 | `offline` | ⚫ 关灯 |

**工作原理**：Copilot 会把每一轮对话的生命周期事件（`user.message`、`assistant.turn_start`、`tool.execution_start`、`assistant.turn_end` 等）写入本地 transcript 日志文件。插件实时监听该文件的追加写入，并同时监听 VS Code 终端执行事件，解析事件并切换灯光状态：

- 收到用户消息 / 开始推理 / 生成文本 → 🟢 绿色
- 工具请求出现后明显停滞（约 4 秒，说明在等你点确认）→ 🟡 黄色闪烁
- 你点确认 / 工具开始执行 → 🟡 黄色跑马灯
- 工具执行完成 → 🟢 绿色
- 整轮回复结束且 6 秒内无新活动 → 🔵 蓝色

**工具分类**：只有可能弹出确认框的工具（`run_in_terminal`、文件写入类、读取 workspace 外文件等）才会进入审批检测；如果工具被自动批准并开始执行，会切换到黄色跑马灯，不会闪黄。`read_file`（workspace 内）、`grep_search`、`get_errors` 等只读工具不影响灯色，保持绿色。

> 说明：长时间推理或长命令执行（数十秒至数分钟）期间灯光会稳定保持绿色或黄色跑马灯，不会误判为空闲。

### 💬 Chat 直接控制 (@ring)

在 Copilot Chat 中使用 `@ring` 直接控制灯光：

```
@ring red              → 设为红色
@ring rainbow          → 彩虹效果
@ring state busy       → 设置为忙碌状态
@ring brightness 200   → 设置亮度
@ring status           → 查询设备状态
@ring help             → 查看所有命令
```

### 🔍 设备发现

一键扫描局域网内的 Ring Light 设备，可从命令面板选择设备，也可以在侧边栏中扫描并填入连接配置。

### 🎛️ 侧边栏控制面板

左侧活动栏 💡 图标，点击打开完整控制面板：

- 🔌 连接 / 配置：切换 HTTP、UDP、Serial，保存主机、端口、串口和波特率
- 🔎 发现设备：扫描局域网设备，点击结果后自动填入主机和端口
- 🔁 连接 / 断开：无需打开 Settings 或命令面板即可管理连接
- ✅ 同步开关：启用或暂停 Copilot 状态同步，手动灯光控制仍可使用
- ⚡ 电源开关
- 🔆 亮度/速度滑杆实时调节
- 🎨 颜色取色器 + 10 个预设色
- ✨ 15 种灯效一键切换
- 🤖 8 种智能体状态按钮
- 📊 设备状态实时展示 (5 秒自动刷新)

功能与固件内置 Web 控制面板一致，无需打开浏览器。

### 📡 多通道连接

- **HTTP** (默认) — WiFi REST API, 稳定可靠
- **UDP** — WiFi 数据报, 最低延迟
- **Serial** — USB CDC 直连, 开发调试用

## 安装

### 一键打包安装

```bash
# Linux / macOS
./scripts/pack.sh

# Windows PowerShell
.\scripts\pack.ps1
```

脚本自动执行 `npm install` → `tsc compile` → `vsce package`，完成后输出安装命令。

### 安装 VSIX

```bash
code --install-extension agent-aura-copilot-0.3.0.vsix
```

或在 VS Code 中: Extensions 面板 → `...` → **Install from VSIX...**

### 手动构建

```bash
cd Agent_Plugin/agent-aura-copilot
npm install
npm run compile          # 仅编译 (开发调试用 F5)
npx @vscode/vsce package # 打包 .vsix
```

## 配置

在 VS Code Settings 中搜索 `agentAura`:

| 设置项 | 默认值 | 说明 |
|---|---|---|
| `agentAura.enabled` | `true` | 启用/禁用状态同步 |
| `agentAura.transport` | `http` | 连接方式: http/udp/serial |
| `agentAura.host` | *(空)* | 设备 IP 或主机名 |
| `agentAura.httpPort` | `80` | HTTP 端口 |
| `agentAura.udpPort` | `8888` | UDP 端口 |
| `agentAura.serialPort` | *(空)* | 串口路径 (/dev/ttyACM0, COM3) |
| `agentAura.serialBaud` | `115200` | 波特率 |
| `agentAura.authToken` | *(空)* | HTTP Bearer 认证令牌，留空则不认证 |
| `agentAura.showStatusBar` | `true` | 状态栏显示连接状态 |

### 认证 (authToken)

当固件开启了 HTTP 认证时，设置 `authToken` 后插件会在所有 HTTP 请求中携带 `Authorization: Bearer <token>` 头。留空则不认证。UDP 和串口传输不携带 token。

可在 VS Code Settings 中设置 `agentAura.authToken`，或通过侧边栏控制面板的「密钥」输入框设置。

## 快速开始

1. 确保 ESP32 Ring Light 已连接 WiFi 并获取到 IP 地址
2. 打开左侧活动栏的 Ring Light 面板
3. 点击 **发现**，选择扫描到的设备，或手动填写 IP/串口配置
4. 点击 **连接**
5. 开始使用 Copilot，灯光会自动同步状态！

也可以通过命令面板 (`Ctrl+Shift+P`) → `AgentAura: Discover Devices` 选择设备并连接。

或者手动配置 Settings:

1. 打开 Settings → 搜索 `agentAura.host` 或 `agentAura.serialPort`
2. 填入设备 IP 地址或串口路径 (如 `192.168.1.100` / `/dev/ttyACM0`)
3. 命令面板 → `AgentAura: Connect to Ring Light`

## 命令面板

| 命令 | 说明 |
|---|---|
| `AgentAura: Connect to Ring Light` | 连接设备 |
| `AgentAura: Disconnect` | 断开连接 |
| `AgentAura: Discover Devices` | 局域网扫描设备 |
| `AgentAura: Send Command` | 发送任意文本指令 |
| `AgentAura: Set Agent State` | 手动切换状态 |

## 架构

```
┌──────────────────────────────────────────────────────┐
│  VS Code                                             │
│                                                      │
│  ┌──────────────────┐    ┌──────────────────────┐   │
│  │ TranscriptWatcher │──>│    StateMapper        │   │
│  │ (monitors Copilot │    │ (activity→agentState) │   │
│  │  chat transcript) │    └──────────┬───────────┘   │
│  └──────────────────┘               │               │
│                                     ▼               │
│  ┌─────────────────┐    ┌──────────────────────┐    │
│  │ ChatParticipant │───>│    DeviceClient       │    │
│  │ (@ring commands) │    │ (HTTP/UDP/Serial)    │    │
│  └─────────────────┘    └──────────┬───────────┘    │
│                                    │                │
│  ┌─────────────────┐              │                │
│  │  StatusBarUI    │<─────────────┘                │
│  └─────────────────┘                               │
└──────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌──────────────────┐
                    │  ESP32 Ring Light │
                    │  (WS2812B × 24)  │
                    └──────────────────┘
```

## 兼容性

- VS Code ≥ 1.93.0
- GitHub Copilot 扩展
- ESP32 Ring Light 固件 v1.0.0+

## License

MIT
