/*
 * ============================================================
 *  ESP32 圆环灯板全能固件 v1.0 — Arduino IDE 入口
 *
 *  本文件为 Arduino IDE 的 sketch 标识文件 (必须与文件夹同名)。
 *  完整固件代码位于 src/ 目录:
 *    src/main.cpp        程序入口 (setup / loop)
 *    src/config.h        硬件/默认/网络/BLE 常量
 *    src/effects.cpp     15 种灯效
 *    src/led_driver.cpp  FastLED 驱动 + 调度
 *    src/command.cpp     统一指令解析器
 *    src/network.cpp     WiFi STA/AP + 配置页
 *    src/http_api.cpp    REST API + WLED 兼容
 *    src/udp_cmd.cpp     UDP 指令 + 局域网发现
 *    src/mqtt_client.cpp MQTT + HA 自动发现
 *    src/ble_server.cpp  NimBLE GATT 服务
 *    src/web/index_html.h 控制面板 + 配置页 (PROGMEM)
 *
 *  Arduino IDE (1.8.10+ / 2.x) 会自动编译 sketch 目录下 src/
 *  子目录的所有 .cpp/.h, 无需手动添加。PlatformIO 同样编译
 *  src/, 两套工具链完全兼容, 不需要修改任何代码。
 *
 *  ---------- Arduino IDE 设置 (详见 README.md) ----------
 *    开发板:           ESP32C3 Dev Module
 *    Partition Scheme: Huge APP (3MB No OTA/1MB SPIFFS)
 *    USB CDC On Boot:  Enabled
 *    USB Mode:         USB-OTG (TinyUSB)
 *    Upload Speed:     921600
 *
 *  ---------- 依赖库 (库管理器安装) ----------
 *    FastLED         (搜 "FastLED")
 *    ArduinoJson v7  (搜 "ArduinoJson")
 *    PubSubClient    (搜 "PubSubClient")
 *    NimBLE          随 ESP32 板支持包自带, 无需安装
 *
 *  本文件故意不含 setup()/loop(), 由 src/main.cpp 提供。
 * ============================================================
 */
