# ESP32 Ring Light 固件 v1.1 — 接口文档

## 目录

- [1. 概述](#1-概述)
- [2. 文本指令集 (全通道通用)](#2-文本指令集-全通道通用)
- [3. USB 串口 (CDC)](#3-usb-串口-cdc)
- [4. HTTP REST API](#4-http-rest-api)
- [5. UDP 指令 & 设备发现](#5-udp-指令--设备发现)
- [6. MQTT (含 Home Assistant 自动发现)](#6-mqtt-含-home-assistant-自动发现)
- [7. BLE GATT 服务](#7-ble-gatt-服务)
- [8. 统一状态 JSON](#8-统一状态-json)
- [9. 智能体状态映射](#9-智能体状态映射)
- [10. WLED 兼容接口](#10-wled-兼容接口)

---

## 1. 概述

| 项目 | 说明 |
|---|---|
| 固件名 | `ESP32-Ring` v1.1.0 |
| 硬件 | ESP32-C3 + WS2812B × 24 (GPIO3) |
| 灯效数 | 15 种 |
| 控制通道 | USB/HTTP/UDP/MQTT/BLE |
| 统一指令 | 所有通道复用同一套文本指令格式 |
| 持久化 | NVS (Preferences), 上电恢复上次状态 |
| 启动行为 | 绿色跑马灯 3 圈 → 关灯等待指令 |

### 通信架构

```
                    ┌─────────────┐
 USB-CDC  ─────────>│             │
 HTTP API ─────────>│  command.cpp ├──> state ──> led_driver ──> WS2812B
 UDP Cmd  ─────────>│  (统一解析器) │
 MQTT     ─────────>│             │
 BLE GATT ─────────>└─────────────┘
```

---

## 2. 文本指令集 (全通道通用)

所有控制通道（USB / UDP / MQTT topic `ring/cmd` / BLE COLOR CHAR）**共用同一套文本指令**。

### 格式

```
<命令> [参数...]
```

一行一条，回车执行，大小写不敏感。响应以 `OK` / `ERR` 开头。

---

### 2.1 颜色

```
rgb R,G,B
```

| 参数 | 范围 | 说明 |
|---|---|---|
| R,G,B | 0-255 | RGB 分量 |

**示例:**
```
rgb 255,0,0      → 纯红
rgb 0,0,255      → 蓝色
rgb 255,255,255  → 白色
```

---

### 2.2 灯效

```
effect <名称> [参数...]
```

| 名称 | 参数 | 说明 |
|---|---|---|
| `solid` | R,G,B | 常亮 |
| `breath` | R,G,B | 正弦呼吸 |
| `flow` | R,G,B | 单点跑马灯 |
| `rainbow` | *(可选 speed)* | 彩虹渐变旋转 |
| `gradient` | R1,G1,B1,R2,G2,B2 | 双色渐变旋转 |
| `blink` | R,G,B | 闪烁 |
| `fire` | *无* | 火焰模拟 |
| `sparkle` | R,G,B | 星光闪烁 |
| `cycle` | R,G,B | 色相循环 |
| `meteor` | R,G,B | 流星拖尾 |
| `bounce` | R,G,B | 弹跳 |
| `wave` | R1,G1,B1,R2,G2,B2 | 双色波浪 |
| `pulse` | R,G,B | 快速脉冲 |
| `fade` | R,G,B | 淡入淡出 |
| `random` | *无* | 每 6 秒随机切换 |

**示例:**
```
effect breath 0,255,100       → 绿色呼吸
effect rainbow                → 彩虹
effect gradient 255,0,0,0,0,255  → 红→蓝渐变
effect fire                   → 火焰
```

---

### 2.3 亮度 & 速度

```
brightness N      简写: brt N
speed N           简写: spd N
```

| 参数 | 范围 | 默认 | 说明 |
|---|---|---|---|
| N | 0-255 | br=64, spd=128 | 0=最暗/最慢, 255=最亮/最快 |

**示例:**
```
brightness 200     → 亮度 200
speed 50           → 速度 50 (慢)
```

---

### 2.4 开关

```
power on         开灯
power off        关灯
power 1          开灯
power 0          关灯
```

---

### 2.5 状态查询

```
state
```
返回 [统一状态 JSON](#8-统一状态-json)。

---

### 2.6 重置

```
reset            恢复默认 (保留 WiFi)
factory          恢复出厂 (清除 WiFi)
```

---

### 2.7 WiFi 配网

```
wifi SSID,PASSWORD
```

**示例:**
```
wifi MyHome,12345678
```
保存后需手动重启设备。

---

### 2.8 智能体状态

```
agent <状态名>
```

见 [§9 智能体状态映射](#9-智能体状态映射)。

---

### 2.9 帮助

```
help
```

---

## 3. USB 串口 (CDC)

| 参数 | 值 |
|---|---|
| 波特率 | **115200** |
| 换行符 | `\n` (LF) |
| 响应格式 | 纯文本回显 |

**Python 示例:**
```python
import serial
ser = serial.Serial("COM3", 115200, timeout=2)
ser.write(b"rgb 255,0,0\n")
print(ser.readline().decode())   # OK rgb
```

---

## 4. HTTP REST API

仅 STA 模式可用。端口 **80**。

### 4.1 控制面板

```
GET /
```
返回 SPA 控制面板页面 (HTML)。

---

### 4.2 状态查询

```
GET /api/state
```
返回 [统一状态 JSON](#8-统一状态-json)。

---

### 4.3 通用文本指令

```
POST /api/cmd
Content-Type: text/plain

rgb 255,0,0
```
Body 即文本指令，与串口格式完全一致。

---

### 4.4 JSON API

#### 设置颜色
```
POST /api/color
Content-Type: application/json

{"r": 255, "g": 0, "b": 0}
```

#### 设置灯效
```
POST /api/effect
Content-Type: application/json

{
  "effect": "breath",
  "r": 0, "g": 255, "b": 100,
  "r2": 0, "g2": 0, "b2": 255,     // 可选: 第二色
  "speed": 200,                     // 可选
  "brightness": 128                  // 可选
}
```

#### 设置亮度
```
POST /api/brightness
Content-Type: application/json

{"value": 200}
```

#### 设置速度
```
POST /api/speed
Content-Type: application/json

{"value": 220}
```

#### 智能体状态
```
POST /api/agent?state=running
```

---

### 4.5 重置

```
GET /reset
```

---

### 4.6 配网页

```
GET /config         → 配网页 (HTML)
POST /save           → 保存 WiFi/MQTT 配置并重启
```

---

## 5. UDP 指令 & 设备发现

端口 **8888**。发送文本指令到设备 UDP 端口，设备回送响应到发送方端口。

### 5.1 文本指令
```python
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.sendto(b"rgb 255,0,0\n", ("192.168.1.100", 8888))
resp, _ = s.recvfrom(1024)
print(resp.decode())   # OK rgb
```

### 5.2 设备发现

广播 `discover` / `ping` / `who` 到端口 8888，设备回送 JSON:
```
UDP → discover
UDP ← {"device":"ESP32-Ring","model":"RingLight-C3","fw":"1.1.0","ip":"192.168.1.100","mac":"AA:BB:CC:DD:EE:FF","udp":8888,"http":80,"effect":"breath"}
```

---

## 6. MQTT (含 Home Assistant 自动发现)

| 参数 | 值 |
|---|---|
| 默认 Broker | 配网页配置 |
| 默认端口 | 1883 |
| 默认 Topic 前缀 | `ring` |
| QoS | 0 (sub) / 1 (pub status) |

### 6.1 主题结构

| 主题 | 方向 | 说明 |
|---|---|---|
| `ring/cmd` | 订阅 | 通用文本指令 (与串口一致) |
| `ring/color/set` | 订阅 | JSON `{"r","g","b"}` |
| `ring/effect/set` | 订阅 | JSON `{"effect","r","g","b",...}` |
| `ring/brightness/set` | 订阅 | 纯数字或 `{"value":N}` |
| `ring/speed/set` | 订阅 | 纯数字或 `{"value":N}` |
| `ring/status` | 发布 | 状态 JSON (retain) |

### 6.2 Home Assistant 自动发现

首次连接 Broker 时自动发布 `homeassistant/light/ring/config`。
HA 会识别为一个支持 RGB + 效果列表 + 亮度的灯光实体。

---

## 7. BLE GATT 服务

| 项目 | 说明 |
|---|---|
| 完整设备名 | `ESP32-Ring-XXXX`（主动扫描；XXXX 为 MAC 后 4 位十六进制） |
| 主广播短名 | `RingXXXX`（与 Service UUID 同包，供硬件过滤和被动扫描识别） |
| 广播间隔 | 20-40ms |
| TX 功率 | +9dBm |
| 库 | NimBLE-Arduino v2.x |
| 默认状态 | 启用（`BLE_ENABLED=true`）；`bluetooth on/off` 仅修改本次运行状态 |
| 广播布局 | 主广播：Flags + 128-bit Service UUID + 短名；扫描响应：完整设备名 |
| 初始化顺序 | LED → BLE → WiFi；ESP32-C3 / IDF 4.4 不得在 WiFi STA/AP 启动后首次初始化 BLE |

### 服务与特征

| 类型 | UUID | 属性 | 说明 |
|---|---|---|---|
| Service | `8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0` | — | 主服务 |
| COLOR | `8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0` | `WRITE \| WRITE_NR \| READ \| NOTIFY` | 写入文本指令，回写响应 |
| STATE | `8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0` | `READ \| NOTIFY` | 读取状态 JSON |

- 写入 COLOR 特征的文本会作为文本指令解析，响应通过 NOTIFY 推出
- STATE 主动读取返回完整状态 JSON
- `connections.ble` 表示当前是否有客户端连接；`connections.ble_running` 表示 GATT 服务是否已启动
- `bluetooth on/off` 命令控制 BLE 运行时开关
- PetDesktop 使用 Service UUID 过滤扫描；UUID 必须位于主广播包。完整名称在主动扫描取得扫描响应后显示
- 通用 BLE GATT 设备不保证出现在手机系统配对页，应使用 PetDesktop、nRF Connect 或 LightBlue 扫描

### ESP32-C3 共存说明

旧实现先启动 WiFi STA/AP、再调用 `NimBLEDevice::init()`，会在
Arduino-ESP32 2.0.17 / ESP-IDF 4.4 的 `coex_core_enable()` 中触发
`abort()`，造成设备重启并反复播放绿色启动跑马灯。当前实现通过
“BLE 先于 WiFi 初始化”修复。实机已验证 BLE UUID 过滤发现、GATT
连接、服务枚举、WiFi AP 与 FastLED 灯效可同时工作。

BLE 控制器不使用 RMT 外设；FastLED 的 RMT 输出不是本次崩溃根因。
ESP32-C3 不应通过 `FASTLED_ESP32_I2S` 规避该问题。

---

## 8. 统一状态 JSON

```json
{
  "device": "ESP32-Ring",
  "firmware": "1.1.0",
  "uptime": 12345,

  "wifi": {
    "connected": true,
    "ssid": "MyHome",
    "rssi": -45,
    "ip": "192.168.1.100",
    "mode": "STA"
  },

  "led": {
    "num_leds": 24,
    "brightness": 64,
    "speed": 128,
    "power": true
  },

  "current": {
    "effect": "breath",
    "color":  { "r": 0, "g": 255, "b": 100 },
    "color2": { "r": 0, "g": 0,   "b": 255 }
  },

  "connections": {
    "usb":  true,
    "http": true,
    "udp":  true,
    "mqtt": true,
    "ble":  false,
    "ble_running": true
  },

  "settings": {
    "ble_enabled": true
  }
}
```

---

## 9. 智能体状态映射

`agent <状态>` 一键切换预设效果和颜色。每个状态可携带**专用速度**与**自动关灯**配置。

| 状态名 | 别名 | 灯效 | 颜色 | 速度 | 自动关灯 | 说明 |
|---|---|---|---|---|---|---|
| `running` | — | breath | 🟢 (0,255,0) | 用户值 | 无 | 正常运行中 |
| `busy` | `processing` | flow | 🟡 (255,200,0) | 用户值 | 无 | 忙碌处理 |
| `waiting` | — | blink | 🟡 (255,200,0) | 用户值 | 无 | 等待审批 |
| `error` | — | blink | 🔴 (255,0,0) | 用户值 | 无 | 错误异常 |
| `idle` | — | breath | 🔵 (0,100,255) | **230** | **5s** | 空闲：快速丝滑呼吸，5 秒后自动关灯 |
| `init` | — | rainbow | 默认 | 用户值 | **3s** | 初始化中：彩虹，3 秒后自动关灯 |
| `offline` | `standby` | (关灯) | 黑 | — | 无 | 离线关灯 |
| `upgrade` | `updating` | meteor | 🟠 (255,165,0) | 用户值 | 无 | 升级中 |

**速度列说明**：`用户值` 表示沿用 NVS 中保存的 `speed`（默认 `DEFAULT_SPEED=128`）；仅 `idle` 强制专用速度 `230` 以获得快速丝滑的呼吸效果。

**自动关灯列说明**：`init`、`idle` 两个状态点亮后启动倒计时；若在设定时长内**无任何新指令**则自动关灯；一旦收到任意新指令（`rgb` / `effect` / `agent <其他>` / `brightness` 等），倒计时立即取消，新指令正常接管灯光。时长由 `src/config.h` 的 `INIT_AUTO_OFF_MS`（3000）与 `IDLE_AUTO_OFF_MS`（5000）控制。

---

## 10. WLED 兼容接口

HTTP `/win` 路径兼容部分 WLED API 参数。

```
GET /win?R=255&G=165&B=0&A=128&T=200&FX=9
```

| 参数 | 说明 |
|---|---|
| `R,G,B` | 颜色 |
| `A` | 亮度 (0-255) |
| `T` | 速度 (0-255) |
| `FX` | 效果编号 (0=Solid, 1=Breath, ..., 14=Random) |

---

> 文档版本: v1.1 | 固件: ESP32-Ring v1.1.0 | 硬件: ESP32-C3 / WS2812B × 24
