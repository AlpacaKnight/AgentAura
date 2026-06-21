# QwenPaw RingLight Plugin

将 QwenPaw 智能体（AI Agent）的生命周期事件实时同步到 ESP32 环形灯硬件。
当 QwenPaw 启动、收到消息、思考、调用工具、等待审批、出错、关闭时，
环形灯会切换到对应的灯效，让智能体的运行状态一目了然。

支持 **HTTP / UDP / USB 串口** 三种连接方式，通过前端配置页面可视化选择。

## 工作原理

```
QwenPaw AgentRunner ─┐
                      ├─> runner.py / approval.py ─> mapper.py
ApprovalService ─────┘                                        │
                                                              ▼
                                                   client.py (transport)
                                                      │ ┌─────┴─────┐
                                                      │ │  http     │ ─> POST /api/cmd
                                                      │ │  udp      │ ─> UDP port 8888
                                                      │ │  serial   │ ─> USB CDC 115200
                                                      │ └───────────┘
                                                      ▼
                                            ESP32 Ring Light
```

1. **事件捕获**：`runner.py` 包装 `AgentRunner.query_handler`，
   `approval.py` 包装 `ApprovalService` 的审批方法，复用
   `qwenpaw-pet` 的成熟捕获逻辑。
2. **事件映射**：`mapper.py` 把 QwenPaw 事件映射到固件的
   `agent <状态>` 指令（见下表），并通过去抖避免相同状态频繁重启灯效。
3. **设备控制**：`client.py` 通过策略模式支持三种传输方式（HTTP REST /
   UDP 数据报 / USB 串口），带 350ms 超时和离线冷却，绝不阻塞 QwenPaw 主流程。
4. **设备发现**：`discovery.py` 通过 UDP 广播（端口 8888）自动发现
   局域网内的 ESP32 Ring Light 设备。

## 事件 → 灯效映射

| QwenPaw 事件 | ESP32 状态 | 灯效 | 说明 |
|:---|:---|:---|:---|
| `qwenpaw.startup` | `init` | 🌈 彩虹 | QwenPaw 启动 |
| `qwenpaw.shutdown` | `offline` | 🌑 关灯 | QwenPaw 关闭 |
| `query.received` | `running` | 🟢 绿色呼吸 | 收到新消息 |
| `query.running` | `busy` | 🟡 黄色跑马 | 思考中 |
| `tool.detected` | `busy` | 🟡 黄色跑马 | 调用工具 |
| `query.first_token` | `busy` | 🟡 黄色跑马 | 开始回复 |
| `query.done` | `idle` | 🔵 蓝色呼吸 | 完成，回到空闲 |
| `query.cancelled` | `idle` | 🔵 蓝色呼吸 | 取消，回到空闲 |
| `query.error` | `error` | 🔴 红色闪烁 | 出错 |
| `approval.pending` | `waiting` | 🟡 黄色闪烁 | 等待审批 |
| `approval.approved` | `busy` | 🟡 黄色跑马 | 审批通过，继续执行 |
| `approval.denied` | `error` | 🔴 红色闪烁 | 审批拒绝 |
| `approval.timed_out` | `error` | 🔴 红色闪烁 | 审批超时 |
| `approval.bulk_cancel` | `idle` | 🔵 蓝色呼吸 | 审批批量取消 |

> 状态映射与固件 [`doc/API.md`](../../Arduino_ESP32_RingLight/ESP32_RingLight_Firmware/doc/API.md) §9 完全对应，无需扩展固件。

## 连接方式

| 传输方式 | 适用场景 | 需要的硬件 | 默认端口 |
|:---|:---|:---|:---|
| **HTTP** | WiFi 局域网（推荐） | 设备连接 WiFi | 80 |
| **UDP** | WiFi 局域网（低延迟） | 设备连接 WiFi | 8888 |
| **USB 串口** | 直连开发调试 | USB 数据线 | 115200 baud |

三种传输共用同一套文本指令格式（`agent <state>` / `rgb R,G,B` / `effect <name>` 等），
切换传输方式只需在前端页面选择即可，无需重启 QwenPaw。

## 安装

### 方式一：从 QwenPaw 控制台

在插件管理页面安装 `agentaura`，可指向本地文件夹、上传 `.zip`
或粘贴插件 URL。

### 方式二：从命令行

```bash
# 先用打包脚本生成 zip（见下方"打包"小节）
qwenpaw plugin install ./agentaura-0.2.0.zip
```

> **注意**：本插件支持热加载——安装后无需手动重启 QwenPaw。路由挂载、
> 猴子补丁和前端 bundle 都在启动钩子中动态注册，前端通过版本号缓存破坏
> 自动拉取最新 JS。如果页面未自动刷新，可手动刷新浏览器（`Ctrl+R`）。

### Python 依赖

- `httpx>=0.27` — HTTP/UDP 传输（QwenPaw 本身已有）
- `pyserial>=3.5` — USB 串口传输（仅使用 serial 模式时需要）

若 QwenPaw 未自动解析插件依赖，手动安装：

```bash
pip install -r requirements.txt
```

## 配置

### 1. 前端配置页面（推荐）

安装插件后，QwenPaw 控制台侧边栏出现 **💡 RingLight** 页面：

1. **连接状态**：显示当前传输方式、设备在线状态、当前灯效
2. **连接配置**：
   - 选择连接方式（HTTP / UDP / USB 串口）
   - HTTP/UDP：填写设备 IP 和端口
   - 串口：从下拉列表选择串口（自动枚举），设置波特率
   - 开关：启动时自动发现设备
   - 状态去抖毫秒数
3. **设备发现**：点击「扫描设备」UDP 广播查找局域网内设备，点击「填入配置」一键填入 IP
4. **灯效测试**：点击 `agent running` / `agent busy` 等按钮直接发送状态指令验证灯效

### 2. 环境变量（启动前设置）

```bash
RINGLIGHT_TRANSPORT=http           # http / udp / serial
RINGLIGHT_HOST=192.168.1.100       # http/udp 模式
RINGLIGHT_PORT=80                  # http 默认 80，udp 默认 8888
RINGLIGHT_SERIAL_PORT=COM3         # serial 模式
RINGLIGHT_BAUD=115200              # serial 波特率
RINGLIGHT_DEBOUNCE_MS=500
```

### 3. HTTP API

```bash
curl -X POST http://localhost:8000/api/agentaura/connection-config \
  -H 'Content-Type: application/json' \
  -d '{
    "transport": "http",
    "host": "192.168.1.100",
    "port": 80,
    "debounce_ms": 500,
    "auto_discover": true
  }'
```

## HTTP API

所有路由挂载在 `/api/agentaura` 下：

| 方法 | 路径 | 说明 |
|:---|:---|:---|
| `GET` | `/status` | 插件 + 设备状态（含当前传输方式） |
| `GET` | `/devices` | UDP 扫描发现设备 |
| `GET` | `/serial-ports` | 枚举可用串口（需 pyserial） |
| `POST` | `/connection-config` | 设置传输方式 + 连接参数 |
| `POST` | `/config` | 旧版配置接口（兼容别名） |
| `POST` | `/agent` | 手动切换 agent 状态（用于调试） |
| `POST` | `/test` | `/agent` 的别名 |
| `POST` | `/test-event` | 模拟发送一个 QwenPaw 事件，走完整映射流程 |
| `POST` | `/command` | 发送任意文本指令（如 `rgb 255,0,0`） |
| `GET` | `/state` | 代理访问设备的状态查询 |

### 示例

```bash
# 扫描设备
curl http://localhost:8000/api/agentaura/devices

# 枚举串口
curl http://localhost:8000/api/agentaura/serial-ports

# 切换到串口模式
curl -X POST http://localhost:8000/api/agentaura/connection-config \
  -H 'Content-Type: application/json' \
  -d '{"transport": "serial", "serial_port": "COM3", "baud": 115200}'

# 手动测试灯效
curl -X POST http://localhost:8000/api/agentaura/agent \
  -H 'Content-Type: application/json' \
  -d '{"state": "busy"}'

# 模拟事件
curl -X POST http://localhost:8000/api/agentaura/test-event \
  -H 'Content-Type: application/json' \
  -d '{"event": "query.error"}'

# 发送原始指令
curl -X POST http://localhost:8000/api/agentaura/command \
  -H 'Content-Type: application/json' \
  -d '{"command": "rgb 255,0,0"}'
```

## 目录结构

```
qwenpaw-plugin/
├── plugin.json            # 清单：id/name/version/dependencies/entry/config
├── plugin.py              # 入口：注册 startup/shutdown hooks + HTTP router
├── requirements.txt       # httpx + pyserial
├── src/                   # 后端源码（平铺模块）
│   ├── client.py          #   多传输客户端（http/udp/serial 策略模式）
│   ├── discovery.py       #   UDP 广播发现设备
│   ├── mapper.py          #   事件 → agent 状态映射 + 去抖
│   ├── runner.py          #   patch AgentRunner.query_handler
│   ├── approval.py        #   patch ApprovalService
│   └── router.py          #   FastAPI 路由（配置/发现/串口/测试）
├── ui/                    # 前端 UI（Vite + React + Ant Design）
│   ├── src/
│   │   ├── index.tsx      #   配置页面（连接方式/IP/串口/发现/测试）
│   │   └── qwenpaw-host.d.ts  # QwenPaw 宿主 API 类型声明
│   ├── package.json
│   ├── vite.config.ts
│   ├── tsconfig.json
│   └── .npmrc
├── dist/
│   └── index.js           # 构建产物（打包时自动生成，前端 entry）
├── scripts/
│   ├── pack.ps1           # Windows 打包脚本（含前端构建）
│   └── pack.sh            # macOS/Linux 打包脚本（含前端构建）
└── README.md              # 本文件
```

## 前端开发

前端使用 Vite + React + Ant Design，共享 QwenPaw 宿主的 React/antd 运行时（不重复打包）。

```bash
cd ui
npm install
npm run build    # 输出到 ../dist/index.js
```

构建产物 `dist/index.js` 被 `plugin.json` 的 `entry.frontend` 引用，
QwenPaw 控制台启动时自动加载。

> 修改 `ui/src/` 后需重新 `npm run build` 并重装插件（或直接复制
> `dist/index.js` 到 `~/.qwenpaw/plugins/agentaura/dist/`）。

## 设计要点

- **多传输**：HTTP / UDP / USB 串口三种连接方式，策略模式实现，运行时切换无需重启。
- **零阻塞**：所有设备通信都是 fire-and-forget，350ms 超时 + 离线冷却，
  设备掉线时静默跳过，绝不影响 QwenPaw 主流程。
- **去抖**：相同 agent 状态在 `debounce_ms`（默认 500ms）内不重复发送，
  避免 `busy → busy` 重启灯效闪烁。
- **降级**：QwenPaw patch 失败（如上游类名变更）只记录日志，HTTP 路由
  仍可用于手动控制。串口传输缺少 pyserial 时同样优雅降级。
- **复用**：事件捕获逻辑直接基于 `qwenpaw-pet` 精简，保证与 QwenPaw
  内部 API 的兼容性。

## 打包

打包脚本会自动构建前端 bundle 再打 zip：

```bash
# Windows
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1

# 跳过前端构建（dist/index.js 已是最新时）
powershell -ExecutionPolicy Bypass -File scripts/pack.ps1 -SkipFrontendBuild

# macOS / Linux
bash scripts/pack.sh

# 跳过前端构建
bash scripts/pack.sh --skip-frontend
```

生成的 `.zip` 位于 `dist/` 目录，可直接用 `qwenpaw plugin install` 安装。
