# 🌈 ESP32 WS2812 环形灯控制器

基于 ESP32 + WS2812 幻彩灯珠（24 颗）的 **WiFi 网页控制器**。手机/电脑浏览器打开控制面板，即可远程控制灯的开关、颜色、亮度、灯效，甚至单独点亮每一颗灯珠。

> 本店 ESP32-C3 环形灯板可参考：板载 DIN=IO3、状态指示灯=IO2、BOOT 按键=IO9，另引出 IO0/IO1。

---

## ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 🌐 **WiFi 双模式** | 默认连路由器（STA）；连不上时自动切热点（AP），手机直连 |
| 🔗 **mDNS 域名** | 用 `http://ringlight.local` 访问，不用记 IP |
| 🎨 **颜色控制** | 取色器 + 10 个预设色，自定义任意 RGB |
| 💡 **亮度调节** | 滑块 5–255 实时调节 |
| 🔮 **5 种灯效** | 纯色 / 彩虹 / 呼吸 / 跑马灯 / 流水 |
| 📍 **单灯控制** | 点击网页上 24 个圆点，单独点亮某颗灯珠 |
| 🔌 **电源开关** | 一键开/关，全部熄灭 |
| 📱 **自适应界面** | 深色风格，手机访问体验最佳 |

---

## 🧰 硬件需求

- **ESP32 / ESP32-C3** 开发板（本店环形灯板亦可）
- **WS2812 / WS2812B / NeoPixel** 环形灯板（24 灯）
- 5V 供电（灯多时建议独立电源，ESP32 的 5V 引脚带不动全亮满载）
- 杜邦线若干

### 📌 接线

| WS2812 灯板 | ESP32 |
|-------------|-------|
| **DIN**（数据） | `DATA_PIN`（默认 GPIO3，按板子改） |
| **5V / VCC** | 5V（独立电源时共地） |
| **GND** | GND |

---

## 📦 依赖库

只需要一个库（**不依赖 FastLED**）：

### Adafruit NeoPixel
- Arduino IDE → **工具 → 管理库** → 搜 `Adafruit NeoPixel` → 安装

> `WiFi.h`、`WebServer.h`、`ESPmDNS.h` 已随 ESP32 板支持包自带，无需额外安装。

---

## ⚙️ 配置（烧录前必改）

打开 `ESP32_RingLight.ino`，修改顶部 **配置区**：

```cpp
// --- STA: 连你家路由器 (失败则自动切到 AP 模式) ---
const char* sta_ssid     = "wifiname";      // ← 改成你的 WiFi 名
const char* sta_password = "password";     // ← 改成你的 WiFi 密码

// --- AP: ESP32 自己发的热点 (连不上路由器时启用) ---
const char* ap_ssid      = "RingLight";
const char* ap_password  = "12345678";     // 至少 8 位; 留空则开放热点

// --- mDNS: 用 http://ringlight.local 访问 ---
const char* mdns_name    = "ringlight";

#define NUM_LEDS     24          // 灯珠数量
#define DATA_PIN     3           // ⚠️ WS2812 的 DIN 引脚(按你的板子改)
```

> ⚠️ `DATA_PIN` 必须和你实际接线一致，否则灯不亮（但不会损坏）。本店 ESP32-C3 环形灯板默认 IO3。

---

## 🚀 快速开始

1. **安装库**：库管理器搜 `Adafruit NeoPixel` 并安装
2. **改配置**：按上一节填好 WiFi 名/密码、确认 `DATA_PIN`
3. **选板子**：工具 → 开发板 → 选你的 ESP32（如 "ESP32C3 Dev Module"）
4. **选端口**：工具 → 端口 → 选对应 COM 口
5. **上传**：点上传按钮烧录
6. **看串口**：打开串口监视器（波特率 **115200**），按 RST 复位，看到：
   ```
   WiFi connected (STA mode)
   IP address: 192.168.1.xxx
   mDNS started: http://ringlight.local
   HTTP server started
   ```
7. **打开控制面板**：手机/电脑浏览器访问 `http://ringlight.local`（或串口里的 IP）

---

## 📶 两种使用模式

### 模式 A：家里有路由器（STA）
- 填对 `sta_ssid` / `sta_password`
- 设备和 ESP32 连**同一个 WiFi**
- 浏览器访问 `http://ringlight.local`

### 模式 B：户外/无路由器（AP）
- 让 STA 连接失败（填错密码或留空），等待 10 秒自动进入 AP
- 串口会打印：
  ```
  STA failed, switching to AP mode...
  AP started
  SSID    : RingLight
  Password: 12345678
  AP IP   : 192.168.4.1
  ```
- 手机 WiFi 列表找到 `RingLight`，连上 → 访问 `http://192.168.4.1`

---

## 🌐 Web API

所有功能都暴露为 HTTP GET 接口，方便自动化/接入智能家居：

| 接口 | 作用 | 示例 |
|------|------|------|
| `GET /` | 控制面板网页 | `http://ringlight.local/` |
| `GET /api/on` | 开灯 | |
| `GET /api/off` | 关灯 | |
| `GET /api/color?r=&g=&b=` | 设置颜色 | `?r=255&g=0&b=0` |
| `GET /api/brightness?v=` | 设置亮度 (5–255) | `?v=120` |
| `GET /api/effect?n=` | 切换灯效 (0–4) | `?n=1` |
| `GET /api/led?i=&r=&g=&b=` | 单灯设置 | `?i=0&r=255&g=255&b=0` |
| `GET /api/clear` | 全部熄灭 | |

**灯效编号**：`0` 纯色 ｜ `1` 彩虹 ｜ `2` 呼吸 ｜ `3` 跑马灯 ｜ `4` 流水

> 例：用 curl 一键变红色 → `curl "http://ringlight.local/api/color?r=255&g=0&b=0"`

---

## 📁 项目结构

```
ESP32_RingLight/
├── ESP32_RingLight.ino     # 主程序 (WiFi + 灯效 + API)
└── ring_light_page.h       # 控制面板网页 (HTML/CSS/JS, 存 Flash)
```

---

## 💡 灯效说明

| # | 名称 | 效果 |
|:-:|------|------|
| 0 | **纯色** | 全部灯珠显示当前颜色 |
| 1 | **彩虹** | 24 颗灯珠呈彩虹色环并旋转 |
| 2 | **呼吸** | 当前颜色亮度正弦渐变（呼吸感） |
| 3 | **跑马灯** | 单灯跑动 + 拖尾衰减 |
| 4 | **流水** | 灯珠依次点亮再熄灭（逐格填充） |

---

## ❓ 常见问题

**Q：串口一直打印 `.....`，连不上 WiFi？**
A：STA 模式下 WiFi 名/密码错了。等 10 秒会自动进 AP 模式，或改对 `sta_ssid` / `sta_password`。

**Q：浏览器打不开 `ringlight.local`？**
A：mDNS 兼容性问题，改用串口打印的 IP 地址。iOS/macOS/Win10+ 原生支持，部分老安卓不支持。

**Q：灯完全不亮？**
A：① 检查 `DATA_PIN` 是否和接线一致；② 5V 供电是否到位；③ 灯板 DIN 是否接对（不是 DOUT）。

**Q：一通电就全亮爆闪？**
A：供电不足。多灯全亮时电流很大，请用独立 5V 电源，并与 ESP32 **共地**。

**Q：手机和 ESP32 在同一 WiFi 但访问不到？**
A：路由器开了「AP 隔离 / 访客隔离」会挡掉设备间通信，关闭即可。

---

## 📝 许可

本项目代码可自由用于个人学习和二次开发。灯板硬件及示例参考版权归原作者所有。

