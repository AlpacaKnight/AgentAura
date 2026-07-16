# ESP32-C6 AMOLED 桌宠固件 — 通信协议文档

## 1. 概述

| 项目 | 说明 |
|------|------|
| 固件名称 | AgentAura |
| 固件版本 | 0.1.0 |
| 目标硬件 | Waveshare ESP32-C6-Touch-AMOLED-1.8（SH8601 QSPI AMOLED 368×448 + FT3168 触摸 + ES8311 音频 + AXP2101 PMU） |
| 通信通道 | USB 串口（CDC）、HTTP REST（STA 模式）、BLE GATT、WiFi AP 配网 |
| 统一命令 | `command.cpp` 文本 + JSON 双协议解析 |
| 持久化 | NVS（WiFi 凭据、亮度、音量、蓝牙/无线开关） |
| 开机行为 | 启动动画 → 尝试 WiFi STA → 失败则 AP 配网 |

```
┌──────────────────────────────────────────────────────────┐
│              ESP32-C6 AMOLED 桌宠固件                      │
│                                                          │
│  USB Serial ──┐                                          │
│  (CDC 115200) │                                          │
│               ├─→ command.cpp ──→ state.cpp ──→ ui_manager│
│  HTTP REST ───┤   (文本/JSON)    (运行状态)    (LVGL UI)  │
│  (port 80)    │                  ↓             ↓         │
│               │              storage.cpp   hal/display   │
│  BLE GATT ────┤              (NVS 持久化)   hal/audio     │
│  (NimBLE)     │                                          │
│               │              comm_broadcast              │
│  WiFi AP ─────┘              (approval_response           │
│  (配网门户)                    → USB + BLE)               │
└──────────────────────────────────────────────────────────┘
```

> **注意**：UDP 指令、MQTT 客户端、WebSocket 在 `pin_config.h` / `state.h` 中有配置项和连接标志，但固件尚未实现对应传输层，当前不可用。

---

## 2. 文本指令集（USB / HTTP-GET / BLE 通用）

格式：`<命令> [参数...]`，一行一条，LF（`\n`）结尾，命令名不区分大小写。响应前缀 `OK:` / `ERR:`。

### 2.1 基础命令

| 命令 | 参数 | 说明 | 响应 |
|------|------|------|------|
| `state` | — | 查询完整状态 JSON | JSON 字符串 |
| `help` | — | 显示帮助文本 | 帮助文本 |
| `reset` | — | 重启设备 | （空） |

### 2.2 桌宠控制

| 命令 | 参数 | 说明 | 响应 |
|------|------|------|------|
| `pet state` | `idle\|running\|thinking\|speaking\|error\|sleep\|offline` | 设置宠物状态 | `OK: pet state -> <state>` 或 `ERR: unknown pet state` |
| `pet speak` | `<文本>` | 设置宠物说话气泡 | `OK: pet says "<文本>"` |
| `agent type` | `CLAUDE\|CODEX\|OTHER` | 设置 Agent 类型 | `OK: agent type -> <type>` |

### 2.3 通信开关

| 命令 | 参数 | 说明 | 响应 |
|------|------|------|------|
| `wifi on` / `wifi off` | — | 开关 WiFi | `OK: wifi enabled` / `OK: wifi disabled` |
| `wifi` | `SSID,PASSWORD` | 配置 WiFi 连接 | `OK: connecting to <SSID>` |
| `wifi` | （无有效参数） | 查询 WiFi 状态 | 网络状态 JSON |
| `bluetooth on` / `bluetooth off` | — | 开关蓝牙（别名 `ble`） | `OK: bluetooth enabled` / `OK: bluetooth disabled` |

### 2.4 显示与音量

| 命令 | 参数 | 说明 | 响应 |
|------|------|------|------|
| `brightness` | `0-255` | 设置屏幕亮度 | `OK: brightness -> N` 或 `ERR: brightness 0-255` |
| `volume` | `0-100` | 设置音量 | `OK: volume -> N` 或 `ERR: volume 0-100` |

### 2.5 页面切换

| 命令 | 参数 | 说明 | 响应 |
|------|------|------|------|
| `screen settings` | — | 切换至设置页面 | `OK: switched to settings` |
| `screen apps` | — | 切换至 App 启动器 | `OK: switched to apps` |
| `screen pet` | — | 返回桌宠主界面 | `OK: switched to pet` |

### 示例

```
> help
> pet state running
OK: pet state -> running
> pet speak 正在编译...
OK: pet says "正在编译..."
> agent type CLAUDE
OK: agent type -> claude
> brightness 180
OK: brightness -> 180
> state
{"fw":"0.1.0","device":"ESP32-C6-AMOLED-PET",...}
```

---

## 3. JSON 指令协议（HTTP-POST）

通过 `POST /api/cmd` 发送 JSON，解析 `type` 字段分发。

### 3.1 state_sync — 状态同步

同步 Agent 状态、配额和宠物消息到设备。

请求体：

```json
{
  "type": "state_sync",
  "agent": {
    "type": "claude",
    "state": "running",
    "quota_total": 100,
    "quota_used": 12.5,
    "quota_h5_total": 5,
    "quota_h5_used": 1.2,
    "quota_h5_remaining": 3.8,
    "quota_refresh_sec": 3600
  },
  "pet": {
    "message": "Compiling..."
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `agent.type` | string | `"claude"` / `"codex"` / 其他 |
| `agent.state` | string | `"running"` / `"thinking"` / `"speaking"` / `"idle"` / `"error"`（仅 5 种） |
| `agent.quota_*` | number | 配额信息（可选） |
| `agent.quota_refresh_sec` | number | 配额刷新倒计时秒数，≥0 时生效（可选） |
| `pet.message` | string | 宠物气泡文本，非空时设置（可选） |

响应：`{"status":"ok"}`

### 3.2 approval_request — 审批请求

在设备上弹出审批对话框。

请求体：

```json
{
  "type": "approval_request",
  "id": "req-001",
  "agent": "claude",
  "title": "执行 Bash 命令",
  "description": "rm -rf /tmp/build",
  "confirm_text": "确认",
  "reject_text": "拒绝",
  "timeout": 60
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | string | 审批请求唯一标识 |
| `agent` | string | Agent 类型 |
| `title` | string | 审批标题 |
| `description` | string | 审批描述 |
| `confirm_text` | string | 确认按钮文本（默认 `"确认"`） |
| `reject_text` | string | 拒绝按钮文本（默认 `"拒绝"`） |
| `timeout` | number | 超时秒数（默认 60） |

响应：`{"status":"approval_received","id":"req-001"}`

### 3.3 approval_response — 审批结果（设备主动推送）

用户在设备上确认或拒绝后，设备通过 `comm_broadcast` 向 USB 串口和 BLE 推出：

```json
{"type":"approval_response","id":"req-001","result":"approved"}
```

`result` 为 `"approved"` 或 `"rejected"`。PWR 按键短按也会拒绝当前审批。

> **注意**：HTTP 不支持服务器推送，`approval_response` 仅通过 USB 和 BLE 输出。

---

## 4. USB 串口（CDC）

| 项目 | 说明 |
|------|------|
| 接口 | ESP32-C6 USB-CDC（`ARDUINO_USB_MODE=1`, `ARDUINO_USB_CDC_ON_BOOT=1`） |
| 波特率 | 115200 |
| 换行 | LF（`\n`） |
| 最大行长 | 200 字符 |
| 协议 | 仅文本指令（JSON 不支持） |
| 回显 | 每行输入回显 `>> <line>` |
| 开机 | 打印固件名、设备型号、`type 'help' for commands` |

---

## 5. HTTP REST API

HTTP 服务器仅在 **WiFi STA 模式**下启动，端口 **80**。

| 方法 | 路径 | Content-Type | 说明 |
|------|------|-------------|------|
| `GET` | `/` | `application/json` | 查询完整状态 JSON |
| `GET` | `/api/state` | `application/json` | 同上 |
| `POST` | `/api/cmd` | `application/json` | JSON 指令（`state_sync` / `approval_request`） |
| `GET` | `/api/cmd?cmd=<文本>` | `text/plain` | 文本指令 |

- `POST /api/cmd` 空体返回 `400 {"error":"no body"}`
- `GET /api/cmd` 缺少 `cmd` 参数返回 `400 missing 'cmd' param`
- 其他路径返回 `404`

---

## 6. WiFi 配网（AP 模式）

WiFi STA 连接失败时自动切换到 AP 模式。

| 项目 | 说明 |
|------|------|
| AP SSID | `AgentAura-XXXX`（XXXX 为 MAC 后 4 位十六进制） |
| AP 密码 | 无（开放网络） |
| 信道 | 1 |
| 配网端口 | 80 |

### 配网路由

| 方法 | 路径 | 说明 |
|------|------|------|
| `GET` | `/` | 配网页面（嵌入 HTML） |
| `GET` | `/config` | 同上 |
| `POST` | `/save` | 保存 WiFi 凭据和 MQTT 配置到 NVS，然后重启 |
| `GET` | `/api/scan` | 扫描 WiFi 网络，返回 `{"networks":[{"ssid","rssi","encrypted"}]}` |

配网页面提供 WiFi SSID 下拉选择和密码输入框，通过 `/api/scan` 填充可用网络列表。

---

## 7. BLE GATT 服务

| 项目 | 说明 |
|------|------|
| 设备名称 | `AgentAura-XXXX`（XXXX 为 MAC 后 4 位十六进制） |
| TX 功率 | +9 dBm |
| 库 | NimBLE-Arduino v2.5 |
| 默认状态 | 启用（`BLE_ENABLED=true`） |

### 服务与特征

| 类型 | UUID | 属性 | 说明 |
|------|------|------|------|
| Service | `8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0` | — | 主服务 |
| CMD | `8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0` | `WRITE \| WRITE_NR` | 写入文本指令（仅文本，以 `\n` 分隔） |
| STATE | `8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0` | `READ \| NOTIFY` | 读取状态 / 推送审批结果通知 |

- 写入 CMD 特征的文本会逐行解析为文本指令，响应通过 STATE 特征的 NOTIFY 推出
- `approval_response` JSON 通过 STATE 特征的 NOTIFY 推送给已连接的客户端

---

## 8. 统一状态 JSON

`GET /api/state`、`GET /`、`state` 文本指令均返回此结构：

```json
{
  "fw": "0.1.0",
  "device": "ESP32-C6-AMOLED-PET",
  "pet": {
    "state": "idle",
    "emotion": "",
    "message": "正在编译...",
    "h5_depleted": false
  },
  "agent": {
    "type": "none",
    "name": ""
  },
  "connections": {
    "usb": true,
    "wifi": false,
    "ble": false,
    "mqtt": false,
    "ws": false
  },
  "settings": {
    "brightness": 200,
    "volume": 50,
    "ble_enabled": true,
    "wifi_enabled": true
  },
  "quota": {
    "total": 100,
    "used": 0,
    "h5_total": 5,
    "h5_used": 0,
    "h5_remaining": 5,
    "refresh_sec": 0
  },
  "battery": {
    "percent": 0,
    "charging": false,
    "voltage": 0.0
  },
  "approval": {
    "active": false
  }
}
```

- `pet.message` 仅在非空时包含
- `approval.id` / `approval.title` / `approval.description` 仅在 `approval.active` 为 true 时包含
- `pet.emotion` 当前为占位字段，始终为空字符串

---

## 9. 状态枚举

### PetState（桌宠状态）

| 枚举值 | 字符串 | 文本指令 | JSON state_sync |
|--------|--------|:--------:|:----------------:|
| IDLE | `idle` | ✅ | ✅ |
| RUNNING | `running` | ✅ | ✅ |
| THINKING | `thinking` | ✅ | ✅ |
| SPEAKING | `speaking` | ✅ | ✅ |
| ERROR | `error` | ✅ | ✅ |
| SLEEP | `sleep` | ✅ | ❌ |
| OFFLINE | `offline` | ✅ | ❌ |

> 文本指令 `pet state` 接受全部 7 种状态；JSON `state_sync` 的 `agent.state` 仅接受 5 种（不含 `sleep` / `offline`）。

### AgentType（Agent 类型）

| 枚举值 | 字符串 | 说明 |
|--------|--------|------|
| NONE | `none` | 未设置 |
| CLAUDE | `claude` | Claude Code |
| CODEX | `codex` | Codex CLI |
| OTHER | `other` | 其他 Agent |

文本指令 `agent type` 使用大写名（`CLAUDE` / `CODEX` / `OTHER`）；JSON `state_sync` 使用小写名（`claude` / `codex`）。

---

## 10. 构建与烧录

### 环境

```bash
# 在仓库根目录初始化 uv 环境
uv sync

# 验证 PlatformIO
uv run pio --version
```

### 编译

```bash
uv run pio run -e esp32c6
```

产物：`.pio/build/esp32c6/firmware.bin` 和 `firmware.factory.bin`

### 烧录

```bash
# 查找端口
uv run pio device list

# 烧录固件
uv run pio run -e esp32c6 -t upload --upload-port /dev/ttyACM0
```

### 串口监控

```bash
uv run pio device monitor -e esp32c6 -p /dev/ttyACM0 -b 115200
```

### 引脚定义

| 功能 | 引脚 |
|------|------|
| AMOLED QSPI SCLK / CS | GPIO0 / GPIO5 |
| AMOLED QSPI SDIO0~3 | GPIO1 / GPIO2 / GPIO3 / GPIO4 |
| 触摸 I2C SDA / SCL | GPIO8 / GPIO7 |
| 触摸中断 | GPIO15 |
| 音频 I2S MCK / BCK / DI / WS / DO | GPIO19 / GPIO20 / GPIO21 / GPIO22 / GPIO23 |
| 功放使能 | GPIO46 |
| BOOT 按键 | GPIO0 |
| 屏幕分辨率 | 368 × 448 |

> **注意**：请勿使用 RingLight 的 `esp32c3` 配置烧录本设备。

---

## 11. 已知限制

| 项目 | 说明 |
|------|------|
| UDP 指令 / 设备发现 | `pin_config.h` 定义了 `UDP_PORT=8888`，但未实现传输层 |
| MQTT 客户端 | 配网页面可保存 MQTT 配置，但未实现客户端 |
| WebSocket | `state.h` 有 `ws_connected` 标志，但未实现 |
| 屏幕常亮 | `SCREEN_ALWAYS_ON=1`，调试模式下禁用自动息屏（dim/off 超时不生效） |
| `pet.emotion` | 占位字段，始终为空字符串 |
| Apps 页面 | `screen apps` 切换到 App 启动器，当前为占位（WIP） |
| BOOT 长按 | 短按切换语音，长按功能待定 |

---

*文档版本：1.0　|　固件版本：0.1.0　|　硬件：Waveshare ESP32-C6-Touch-AMOLED-1.8*
