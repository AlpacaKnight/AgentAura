# 🌈 ESP32 圆环灯板全能固件 v1.0

基于 **ESP32-C3 + WS2812B 圆环 24 灯** 的全能控制固件，支持 **5 种连接方式**（USB 串口 / WiFi HTTP / WiFi UDP / WiFi MQTT / 蓝牙 BLE）与 **15 种灯效**，内置 **Home Assistant 自动发现**、**NVS 持久化**与**智能体状态映射**，可直接作为智能体运行状态的可视化指示灯。

---

## 一、硬件确认

| 项目 | 规格 |
|:-----|:-----|
| **主控芯片** | ESP32-C3（RISC-V 单核 160MHz，BLE 5.0 only） |
| **灯珠** | WS2812B RGB 圆环 **24 灯** |
| **数据引脚** | **GPIO3**（板载 DIN） |
| **Flash** | 4MB（huge_app 分区，app0 ~3.2MB） |
| **板载资源** | 状态指示灯 IO2 / BOOT 按键 IO9 / 另引出 IO0、IO1 |
| **供电** | USB 5V 供电（24 灯全亮满载建议外接 5V 独立电源并共地） |

### 接线

| WS2812B 圆环 | ESP32-C3 |
|:-------------|:---------|
| **DIN**（数据输入） | GPIO3 |
| **5V / VCC** | 5V（独立供电时与 ESP32 共地） |
| **GND** | GND |

> ⚠️ DIN 必须接 GPIO3（可在 `src/config.h` 的 `LED_PIN` 修改）。接错灯不亮但不会损坏。

---

## 二、功能总览

| 类别 | 说明 |
|:-----|:-----|
| 🔌 **5 种连接** | USB 串口 / WiFi HTTP REST API / WiFi UDP / WiFi MQTT / 蓝牙 BLE |
| 🎨 **15 种灯效** | solid / breath / flow / rainbow / gradient / blink / fire / sparkle / cycle / meteor / bounce / wave / pulse / fade / random |
| 📱 **Web 控制面板** | 单页 Web UI（PROGMEM 内嵌），电源/亮度/速度滑块 + 取色器 + 15 灯效按钮 + 智能体状态快捷键 |
| ⚙️ **AP 配置页** | 首次启动自动 AP 热点，网页配置 WiFi + MQTT |
| 🏠 **HA 自动发现** | MQTT Discovery 一键接入 Home Assistant |
| 💾 **NVS 持久化** | 灯效/颜色/亮度/速度/WiFi/MQTT 全部掉电保存 |
| 🤖 **智能体映射** | 一条指令切换"运行/忙碌/错误/空闲/初始化…"等 8 种预设状态（部分状态支持自动关灯） |
| 📡 **局域网发现** | UDP 广播 `discover` 自动发现设备 |
| 🌐 **mDNS** | `http://ringlight.local` 访问，无需记 IP |
| 🔗 **WLED 兼容** | `/win` API 兼容 WLED 协议（可选） |

---

## 三、项目结构

```
ESP32_RingLight_Firmware/
├── platformio.ini              # C3 配置 + huge_app 分区 + 固件库依赖
├── pyproject.toml              # uv Python 依赖管理 (platformio)
├── src/
│   ├── main.cpp                 # setup()/loop() 入口
│   ├── config.h                 # 硬件/默认/网络/BLE/NVS 常量
│   ├── state.h/.cpp             # 运行时状态 + 统一 JSON 状态
│   ├── storage.h/.cpp           # NVS 读写 (Preferences)
│   ├── led_driver.h/.cpp        # FastLED 封装 + 按速度调度
│   ├── effects.h/.cpp           # 15 种灯效实现
│   ├── command.h/.cpp           # 统一指令解析器 (text + JSON)
│   ├── network.h/.cpp           # WiFi STA/AP + 配置页 + mDNS
│   ├── http_api.h/.cpp          # REST API + WLED 兼容
│   ├── udp_cmd.h/.cpp           # UDP 8888 文本指令 + 发现
│   ├── mqtt_client.h/.cpp       # MQTT 订阅 + HA Discovery
│   ├── ble_server.h/.cpp        # NimBLE GATT 服务
│   └── web/
│       └── index_html.h         # 控制面板 + 配置页 (PROGMEM)
├── ESP32_RingLight_Firmware.ino # Arduino IDE sketch 入口 (stub, 逻辑在 src/main.cpp)
└── README.md                    # 本文档
```

> 活跃固件代码全部在 `src/` 目录下。PlatformIO 直接编译 `src/`；Arduino IDE 打开根目录 `.ino` 后也会自动编译 `src/` 子目录。`pyproject.toml` 用 uv 管理 PlatformIO 的 Python 依赖，Arduino IDE 不需要它。

---

## 四、编译与烧录

本项目支持 **PlatformIO**（推荐）和 **Arduino IDE** 两种工具链编译，编译同一份 `src/` 代码，互不冲突。PlatformIO 的 Python 依赖由 **uv** 管理（见 `pyproject.toml`）。

> 根目录 `ESP32_RingLight_Firmware.ino` 是 Arduino IDE 的 sketch 入口标识（纯 stub，不含 setup/loop，实际逻辑在 `src/main.cpp`）。两套工具链都不会重复编译。

### 依赖总览

**Arduino 固件库**（两种工具链通用）：

| 库 | 版本 | 用途 | PlatformIO | Arduino IDE |
|:---|:-----|:-----|:-----------|:------------|
| FastLED | ^3.7 | LED 驱动（WS2812B） | `platformio.ini` 自动安装 | 库管理器搜 `FastLED` |
| ArduinoJson | ^7.1 | JSON 解析/生成 | `platformio.ini` 自动安装 | 库管理器搜 `ArduinoJson` |
| PubSubClient | ^2.8 | MQTT 客户端 | `platformio.ini` 自动安装 | 库管理器搜 `PubSubClient` |
| NimBLE-Arduino | ^2.3 | BLE（NimBLE 协议栈） | `platformio.ini` 自动安装 | 库管理器搜 `NimBLE-Arduino` |

**PlatformIO Python 依赖**（见 `pyproject.toml`）：

| 包 | 版本 | 用途 |
|:---|:-----|:-----|
| platformio | >=6.1.19 | 编译/上传工具链 |

> Arduino IDE 不需要 Python 和 PlatformIO，只装板包 + 4 个库即可。

### 方式一：PlatformIO（推荐，uv 管理依赖）

#### 1. 安装 uv（首次）

```bash
# Windows (PowerShell)
powershell -ExecutionPolicy ByPass -c "irm https://astral.sh/uv/install.ps1 | iex"

# macOS / Linux
curl -LsSf https://astral.sh/uv/install.sh | sh
```

#### 2. 同步依赖并编译上传

```bash
# 进入项目目录
cd ESP32_RingLight_Firmware

# 同步 Python 依赖（首次，会创建 .venv 并安装 platformio）
uv sync

# 编译固件（首次会自动下载 ESP32 平台和固件库）
uv run pio run

# 上传到设备（连接 USB 后）
uv run pio run -t upload

# 串口监视器（115200 baud）
uv run pio device monitor
```

> 也可直接用 `pio run`（若已全局安装 PlatformIO）。`uv run pio` 的好处是依赖隔离在项目 `.venv` 里，不污染系统环境。

#### 3. PlatformIO IDE（VS Code 插件，可选）

安装 VS Code 的 PlatformIO 插件后直接打开本项目文件夹，插件会自动读取 `platformio.ini`，点底部 ✓ 编译、→ 上传。

### 方式二：Arduino IDE

#### 1. 安装 ESP32 板支持包

- 文件 → 首选项 → 附加开发板管理网址填：
  `https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json`
- 工具 → 开发板 → 开发板管理器 → 搜 `esp32` → 安装（选 **3.x 版本**）

#### 2. 安装依赖库

工具 → 管理库 → 分别搜索安装：
- `FastLED`
- `ArduinoJson`
- `PubSubClient`
- `NimBLE-Arduino`

> NimBLE 必须单独安装。ESP32 板包内置的 BLE 库是 Bluedroid 实现（头文件 `BLEDevice.h`），与本固件使用的 NimBLE（头文件 `NimBLEDevice.h`）不兼容。

#### 3. 打开项目

文件 → 打开 → 选择 `ESP32_RingLight_Firmware.ino`（Arduino IDE 会自动编译 `src/` 下所有源文件）

#### 4. 板设置（工具菜单，⚠️ 必须设对）

| 设置项 | 值 | 说明 |
|:-------|:---|:-----|
| 开发板 | `ESP32C3 Dev Module` | |
| **Partition Scheme** | `Huge APP (3MB No OTA/1MB SPIFFS)` | 不设会 Flash 空间不足 |
| **USB CDC On Boot** | `Enabled` | 不设 USB 串口不识别 |
| USB Mode | `USB-OTG (TinyUSB)` | |
| Upload Speed | `921600` | |
| Port | 选对应 COM 口 | |

#### 5. 上传与监视

- 点上传按钮（→）烧录
- 串口监视器波特率设 `115200`

> ⚠️ **Partition Scheme** 和 **USB CDC On Boot** 必须设对，否则编译失败或 USB 串口不识别。这两项对应 `platformio.ini` 里的 `board_build.partitions` 和 `-DARDUINO_USB_CDC_ON_BOOT=1`。

### 两套工具链对比

| | PlatformIO（uv） | Arduino IDE |
|:--|:-----------------|:------------|
| 依赖管理 | `pyproject.toml` + `platformio.ini` 全自动 | 手动装板包 + 4 个库 |
| 编译命令 | `uv run pio run` | 点上传按钮 |
| 库版本锁定 | `platformio.ini` 指定版本 | 取决于库管理器装的版本 |
| 编辑器 | VS Code（可选） | Arduino IDE |
| Python 需求 | 需要（uv 管理） | 不需要 |
| 推荐场景 | 命令行/CI/版本可控 | 新手/图形界面 |

### 关键配置（`src/config.h`）

如需修改灯珠数、引脚、默认参数等，编辑 `config.h`：

```cpp
#define NUM_LEDS         24          // 圆环灯珠数量
#define LED_PIN          3           // WS2812B DIN -> GPIO3
#define DEFAULT_BRIGHTNESS  128
#define DEFAULT_SPEED       128
#define DEFAULT_EFFECT      "solid"
#define DEFAULT_COLOR_R     0        // 默认绿色
#define DEFAULT_COLOR_G     255
#define DEFAULT_COLOR_B     0
#define UDP_PORT            8888
#define MQTT_PORT           1883
#define BLE_ENABLED         true     // 编译期可关闭 BLE
// 智能体状态自动关灯时长 (无新指令到点自动关灯)
#define INIT_AUTO_OFF_MS    3000UL   // agent init 彩虹持续 3 秒
#define IDLE_AUTO_OFF_MS    5000UL   // agent idle 呼吸灯持续 5 秒
```

---

## 五、5 种连接方式

### 5.1 USB 串口（115200 baud）

插上 USB 自动识别为 COM 端口（C3 板自带 USB-CDC），用串口工具发送文本指令：

```
> rgb 255,0,0          # 设置红色
> effect breath 0,255,0  # 切换绿色呼吸
> brightness 200       # 亮度 200
> speed 200            # 速度 200
> state                # 查询状态（返回 JSON）
> help                 # 帮助
```

### 5.2 WiFi HTTP REST API

连接路由器后，浏览器访问 `http://ringlight.local`（或串口打印的 IP）打开控制面板。

**API 端点：**

| 方法 | 端点 | 说明 | 示例 |
|:-----|:-----|:-----|:-----|
| GET | `/` | Web 控制面板 | |
| GET | `/api/state` | 查询状态（JSON） | |
| POST | `/api/cmd` | 通用文本指令 | body: `rgb 255,0,0` |
| POST | `/api/color` | 设置颜色 | `{"r":255,"g":0,"b":0}` |
| POST | `/api/effect` | 切换效果 | `{"effect":"breath","r":0,"g":255,"b":0}` |
| POST | `/api/brightness` | 设置亮度 | `{"value":128}` |
| POST | `/api/speed` | 设置速度 | `{"value":200}` |
| ANY | `/api/agent?state=idle` | 智能体状态 | |
| GET | `/reset` | 恢复默认 | |
| GET | `/win?R=255&G=0&B=0&A=128&T=200&FX=2` | WLED 兼容 | A=亮度 T=速度 FX=效果编号 |

```bash
# curl 示例
curl -X POST http://ringlight.local/api/cmd -d "effect rainbow"
curl -X POST http://ringlight.local/api/color -H "Content-Type: application/json" -d '{"r":0,"g":255,"b":0}'
curl "http://ringlight.local/win?R=255&G=0&B=0"
```

### 5.3 WiFi UDP（端口 8888）

与串口指令格式完全相同，局域网内极低延迟：

```bash
# 发送指令
echo "rgb 0,255,0" | socat - UDP:192.168.1.100:8888

# 广播发现设备（任何设备收到 "discover" 回送 JSON）
echo "discover" | socat - UDP:255.255.255.255:8888
# 返回: {"device":"ESP32-Ring","ip":"192.168.1.100","mac":"...","udp":8888,...}
```

### 5.4 WiFi MQTT

在 AP 配置页配置 MQTT Broker 后，设备订阅以下主题（默认前缀 `ring`）：

| 主题 | 方向 | 载荷示例 | 说明 |
|:-----|:----:|:---------|:-----|
| `ring/cmd` | ← 订阅 | `rgb 255,0,0` | 通用文本指令 |
| `ring/color/set` | ← 订阅 | `{"r":255,"g":0,"b":0}` | 设置颜色 |
| `ring/effect/set` | ← 订阅 | `{"effect":"breath","r":0,"g":255,"b":0}` | 切换效果 |
| `ring/brightness/set` | ← 订阅 | `128` 或 `{"value":128}` | 设亮度 |
| `ring/speed/set` | ← 订阅 | `200` 或 `{"value":200}` | 设速度 |
| `ring/status` | → 发布 | （完整状态 JSON） | 状态上报（retained） |

```bash
mosquitto_pub -h 192.168.1.100 -t ring/cmd -m "effect fire"
mosquitto_pub -h 192.168.1.100 -t ring/color/set -m '{"r":0,"g":255,"b":0}'
mosquitto_sub -h 192.168.1.100 -t ring/status
```

### 5.5 蓝牙 BLE（NimBLE）

无需 WiFi，手机 BLE 调试 APP 直连控制。广播名 `ESP32-Ring-XXXX`（后 4 位 MAC）。

| 特征值 UUID | 读写 | 载荷 | 说明 |
|:------------|:----:|:-----|:-----|
| `8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0` (CHAR_COLOR) | 写 | `rgb 255,0,0` | 写入文本指令 |
| `8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0` (CHAR_STATE) | 读 | JSON | 读取当前状态 |

> Service UUID: `8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0`

---

## 六、统一指令集

所有连接方式（USB/UDP/MQTT/BLE）共用同一套文本指令：

| 指令 | 示例 | 说明 |
|:-----|:-----|:-----|
| `rgb R,G,B` | `rgb 255,0,0` | 设置单色（自动切到 solid） |
| `effect NAME [params]` | `effect breath 0,255,0` | 切换效果（参数可选） |
| `brightness N` | `brightness 128` | 亮度 0-255 |
| `speed N` | `speed 200` | 速度 0-255（255 最快） |
| `power on\|off` | `power off` | 开关灯 |
| `state` | `state` | 查询状态（返回 JSON） |
| `reset` | `reset` | 恢复默认（保留 WiFi） |
| `factory` | `factory` | 恢复出厂（清空全部，含 WiFi，重启） |
| `wifi SSID,PASSWORD` | `wifi MyHome,12345678` | 串口配网 |
| `agent STATE` | `agent busy` | 智能体状态映射（见 §八） |
| `help` | `help` | 帮助 |

**effect 参数格式**（按效果类型）：

| 效果类型 | 参数示例 | 说明 |
|:---------|:---------|:-----|
| 单色效果 | `effect breath 255,0,0` | `R,G,B` |
| 单色+速度 | `effect flow 0,255,0,200` | `R,G,B,Speed` |
| 双色效果 | `effect gradient 255,0,0,0,0,255` | `R1,G1,B1,R2,G2,B2` |
| 仅速度 | `effect rainbow 200` | `Speed` |
| 无参数 | `effect solid` | 使用当前颜色 |

---

## 七、15 种灯效

| # | 名称 | 参数 | 说明 |
|:-:|:-----|:-----|:-----|
| 0 | `solid` | R,G,B | 单色常亮 |
| 1 | `breath` | R,G,B | 呼吸灯：正弦波亮度渐变循环（步进 6，丝滑过渡） |
| 2 | `flow` | R,G,B,Speed | 流水跑马：灯珠依次亮起流转 |
| 3 | `rainbow` | Speed | 彩虹渐变轮转 |
| 4 | `gradient` | R1,G1,B1,R2,G2,B2 | 双色渐变沿环旋转 |
| 5 | `blink` | R,G,B,Speed | 交替亮灭 |
| 6 | `fire` | Speed | 火焰模拟（HeatColors 调色板） |
| 7 | `sparkle` | R,G,B,Speed | 底色 + 随机白点星光 |
| 8 | `cycle` | Speed | HSL 色环循环换色 |
| 9 | `meteor` | R,G,B,Speed | 流星拖尾划过 |
| 10 | `bounce` | R,G,B,Speed | 光点来回弹跳 |
| 11 | `wave` | R1,G1,B1,R2,G2,B2 | 双色正弦波浪推进 |
| 12 | `pulse` | R,G,B | 快速闪后渐暗 |
| 13 | `fade` | R,G,B,Speed | 淡入淡出 |
| 14 | `random` | Speed | 每 6 秒随机切换到其它效果 |

> 速度 `Speed` 范围 0-255，255 最快（推进间隔 20ms），0 最慢（500ms），对数映射。

---

## 八、智能体状态映射

一条 `agent STATE` 指令即可切换预设的"颜色+效果"组合，适合智能体运行状态可视化。每个状态自带**专用速度**与**自动关灯**配置（见下表）。

| 指令 | 状态 | 颜色 | 效果 | 速度 | 自动关灯 | 说明 |
|:-----|:-----|:-----|:-----|:-----|:---------|:-----|
| `agent running` | 🟢 正常运行 | 绿 `0,255,0` | `breath` | 用户值 | 无 | 缓慢绿色呼吸 |
| `agent busy` | 🟡 忙碌/处理中 | 黄 `255,200,0` | `flow` | 用户值 | 无 | 黄色跑马流转 |
| `agent waiting` | 🟡 等待审批 | 黄 `255,200,0` | `blink` | 用户值 | 无 | 黄色闪烁 |
| `agent error` | 🔴 错误/异常 | 红 `255,0,0` | `blink` | 用户值 | 无 | 红色快速闪烁 |
| `agent idle` | 🔵 空闲 | 蓝 `0,100,255` | `breath` | **230（快速丝滑）** | **5 秒** | 蓝色快速丝滑呼吸，5 秒后自动关灯 |
| `agent init` | 🌈 初始化中 | 默认 | `rainbow` | 用户值 | **3 秒** | 彩虹渐变轮转，3 秒后自动关灯 |
| `agent offline` | 🌑 离线/待机 | 关灯 | — | — | 无 | 关闭灯光（`power off`） |
| `agent upgrade` | 🟠 升级中 | 橙 `255,165,0` | `meteor` | 用户值 | 无 | 橙色流星效果 |

> **别名**：`processing`=busy, `standby`=offline, `updating`=upgrade
>
> **"用户值"** 表示沿用 NVS 中保存的 `speed`（即用户通过 `speed N` 设置或默认 `DEFAULT_SPEED=128`）。只有 `idle` 会强制一个专用高速（230）以获得快速丝滑的呼吸效果。

### 自动关灯机制（Auto-Off）

`init` 和 `idle` 两个状态带有**定时自动关灯**：

- 触发后立即点亮显示对应效果；
- 若在设定时长内（`init`=3 秒、`idle`=5 秒）**没有任何新指令**，设备自动关灯（`power off`）；
- 若在此期间收到**任何新指令**（如 `rgb` / `effect` / `agent <其他状态>` / `brightness` 等），**自动关灯立即取消**，新指令正常生效并接管灯光。

> 该机制通过全局倒计时实现（`scheduleAutoOff` / `cancelAutoOff`），相关常量在 `src/config.h`：
> ```cpp
> #define INIT_AUTO_OFF_MS    3000UL   // agent init 彩虹持续 3 秒
> #define IDLE_AUTO_OFF_MS    5000UL   // agent idle 呼吸灯持续 5 秒
> ```

### 与 QwenPaw 插件的事件映射

搭配 [AgentAura QwenPaw 插件](../../Agent_Plugin/qwenpaw-plugin) 使用时，QwenPaw 的生命周期事件会自动映射到上述状态：

| QwenPaw 事件 | ESP32 状态 | 说明 |
|:---|:---|:---|
| `qwenpaw.startup` | `init` | QwenPaw 启动 → 彩虹 |
| `qwenpaw.shutdown` | `offline` | QwenPaw 关闭 → 关灯 |
| `query.received` | `running` | 收到新消息 → 绿色呼吸 |
| `query.running` / `tool.detected` / `query.first_token` | `busy` | 思考/调用工具/回复中 → 黄色跑马 |
| `query.done` / `query.cancelled` | `idle` | 完成/取消 → 蓝色呼吸 |
| `query.error` | `error` | 出错 → 红色闪烁 |
| `approval.pending` | `waiting` | 等待审批 → 黄色闪烁 |
| `approval.approved` | `busy` | 审批通过 → 黄色跑马 |
| `approval.denied` / `approval.timed_out` | `error` | 审批拒绝/超时 → 红色闪烁 |

插件支持 HTTP / UDP / USB 串口三种连接方式，可在 QwenPaw 控制台的 **RingLight** 配置页面选择。

---

## 九、Home Assistant 接入

1. 在 AP 配置页填写 MQTT Broker 地址，勾选"启用 MQTT"
2. 保存重启，设备连接 MQTT 后自动发布 Discovery 信息到 `homeassistant/light/ring/config`
3. HA 自动识别为 **light 实体**，支持：开关、亮度调节、RGB 颜色、15 种效果切换
4. 状态实时上报到 `ring/status`

**Discovery 配置内容：**

```json
{
  "name": "ESP32 Ring Light",
  "uniq_id": "esp32_ring_light",
  "schema": "json",
  "state_topic": "ring/status",
  "command_topic": "ring/effect/set",
  "brightness": true,
  "color_mode": true,
  "supported_color_modes": "rgb",
  "effect_list": ["solid","breath","flow","rainbow","gradient","blink",
                   "fire","sparkle","cycle","meteor","bounce","wave",
                   "pulse","fade","random"],
  "brightness_command_topic": "ring/brightness/set",
  "brightness_state_topic": "ring/status",
  "brightness_value_template": "{{ value_json.led.brightness }}"
}
```

---

## 十、状态查询 JSON 格式

所有连接方式的 `state` 查询返回统一 JSON：

```json
{
  "device": "ESP32-Ring",
  "firmware": "1.0.0",
  "uptime": 3600,
  "wifi": {
    "connected": true,
    "ssid": "MyHome",
    "rssi": -45,
    "ip": "192.168.1.100",
    "mode": "STA"
  },
  "led": {
    "num_leds": 24,
    "brightness": 128,
    "speed": 128,
    "power": true
  },
  "current": {
    "effect": "breath",
    "color": {"r": 0, "g": 255, "b": 0},
    "color2": {"r": 0, "g": 0, "b": 255}
  },
  "connections": {
    "usb": true,
    "http": true,
    "udp": true,
    "mqtt": true,
    "ble": true
  }
}
```

---

## 十一、首次使用流程

1. **烧录固件**：`pio run -t upload`
2. **进入配网**：上电后若无 WiFi 配置，自动开启 AP 热点 `ESP32-Ring-XXXX`
3. **连接热点**：手机连上该热点
4. **打开配置页**：浏览器访问 `http://192.168.4.1`
5. **填写配置**：输入 WiFi SSID/密码，按需填写 MQTT Broker
6. **保存重启**：设备自动重启并连接路由器
7. **开始使用**：访问 `http://ringlight.local` 或串口/IP 控制灯效

---

## 十二、接口测试

`test/` 目录提供真机接口测试脚本，覆盖全部 5 种连接方式。

### 配置

编辑 `test/config.json` 填写设备信息：

```json
{
  "host": "192.168.1.100",       // 设备 IP (HTTP/UDP 测试用)
  "http_port": 80,
  "udp_port": 8888,
  "serial_port": "COM3",         // 串口 (Windows) / /dev/ttyACM0 (Linux/Mac)
  "serial_baud": 115200,
  "ble_device_name": "ESP32-Ring",  // BLE 设备名前缀
  "mqtt_host": "192.168.1.100",     // MQTT Broker IP
  "mqtt_port": 1883,
  "mqtt_topic": "ring",
  "test_http": true,             // 各测试项开关
  "test_udp": true,
  "test_ble": true,
  "test_mqtt": true,
  "test_serial": true
}
```

### 运行测试

```bash
# HTTP + UDP + 智能体 + 15灯效 + 串口
python test/test_interfaces.py

# BLE + MQTT (需要额外依赖: pip install bleak paho-mqtt)
python test/test_ble_mqtt.py
```

### 测试覆盖

| 脚本 | 连接方式 | 测试内容 | 依赖 |
|:-----|:---------|:---------|:-----|
| `test_interfaces.py` | HTTP | 状态查询/文本指令/JSON接口/WLED兼容/重置 (10项) | 无 |
| | UDP | 设备发现/指令发送/状态查询 (6项) | 无 |
| | 智能体 | 8种状态+2别名 (10项) | 无 |
| | 灯效 | 15种效果遍历 | 无 |
| | 串口 | rgb/effect/agent/state/help/power/reset (11项) | pyserial |
| `test_ble_mqtt.py` | BLE | 扫描/连接/读状态/写指令/7种控制 (11项) | bleak |
| | MQTT | 连接/订阅/5种主题发布/状态接收 (9项) | paho-mqtt |

未配置的接口自动跳过，空配置直接报错提示。

---

## 十三、FAQ

**Q：串口一直打印 `.....`，连不上 WiFi？**
A：WiFi 密码错了。等 10 秒自动进 AP 模式，连热点后重新配置；或串口发 `wifi SSID,PASSWORD`。

**Q：浏览器打不开 `ringlight.local`？**
A：mDNS 兼容性问题，改用串口打印的 IP 地址。iOS/macOS/Win10+ 原生支持，部分老安卓不支持。

**Q：灯完全不亮？**
A：① 检查 `config.h` 的 `LED_PIN`（默认 GPIO3）是否和接线一致；② 5V 供电是否到位；③ 灯板 DIN 是否接对（不是 DOUT）。

**Q：一通电就全亮爆闪？**
A：供电不足。24 灯全亮白光电流约 1.4A，USB 口带不动，请用独立 5V 电源并与 ESP32 共地。

**Q：BLE 连接不稳定？**
A：ESP32-C3 的 BLE 与 WiFi 并存时，大数据传输可能影响 WiFi。本固件 BLE 只传短指令，影响可控。如需彻底关闭 BLE，在 `config.h` 设 `BLE_ENABLED false` 重新编译。

**Q：FastLED 在 C3 上灯不亮？**
A：FastLED 已支持 ESP32-C3 的 RMT 时序（实测 3.10.3）。如个别板子仍有问题，确认 Flash 供电稳定，或降低 `DEFAULT_BRIGHTNESS` 测试。

**Q：如何恢复出厂设置？**
A：串口发 `factory`，或 Web 面板 `GET /reset`（恢复默认保留 WiFi）；`factory` 清空全部含 WiFi。

**Q：手机和 ESP32 在同一 WiFi 但访问不到？**
A：路由器开了「AP 隔离 / 访客隔离」会挡掉设备间通信，关闭即可。

**Q：MQTT 连不上？**
A：检查 Broker 地址/端口/用户名/密码；PubSubClient 默认 buffer 768 字节，状态 JSON 较大时已自动调大。串口会打印 `[mqtt] connect failed, state=X`，state=4 表示用户名密码错，state=2 网络不通。

**Q：OTA 升级？**
A：当前使用 huge_app 分区（无 OTA 空间），需 USB 线重新烧录。如需 OTA，需切换回默认分区表。

---

## 十四、技术说明

| 组件 | 方案 | 说明 |
|:-----|:-----|:-----|
| LED 驱动 | FastLED | 成熟稳定，内置 sin8/fade/调色板 |
| BLE | h2zero/NimBLE-Arduino 2.x | 独立库，C3 上比板包内置 Bluedroid 省 Flash |
| HTTP | 内置 WebServer | 同步模式，C3 上比 AsyncTCP 稳定 |
| MQTT | PubSubClient | 轻量，兼容 HA |
| JSON | ArduinoJson v7 | 按需求文档 |
| 持久化 | Preferences (NVS) | 内置无依赖 |
| 配网 | 自实现 AP 配置页 | 减少 WiFiManager 依赖 |

### Flash 占用（实测）

| 资源 | 占用 | 上限 | 占比 |
|:-----|:-----|:-----|:-----|
| Flash | 1,066,226 字节（~1.04MB） | 3,145,728 字节（~3.2MB，huge_app 分区） | 33.9% |
| RAM | 49,660 字节（~48KB） | 327,680 字节（~320KB） | 15.2% |

> 全功能固件实际仅占 Flash 33.9%，远低于 huge_app 分区上限，留有充足余量。实测库版本：FastLED 3.10.3、ArduinoJson 7.4.3、PubSubClient 2.8.0、NimBLE-Arduino 2.5.0。

### 不在当前范围

- LittleFS 文件系统烧录（网页走 PROGMEM，避免额外烧 data 步骤）
- OTA 升级（huge_app 分区无 OTA 空间）
- 48 小时长稳测试 / 现场硬件验证（需用户在真机上跑）

---

## 许可

本项目代码可自由用于个人学习和二次开发。

---

*固件版本：v1.0.0 · 编译验证通过 · 日期：2026-06-21*
