/*
 * ============================================================
 *  config.h — ESP32 圆环灯板全能固件 全局配置
 *  集中管理硬件 / 默认值 / 网络 / BLE / NVS key
 * ============================================================
 */
#pragma once
#ifndef RING_CONFIG_H
#define RING_CONFIG_H

// -------------------- 固件信息 --------------------
#define FW_VERSION       "1.1.0"
#define FW_NAME          "ESP32-Ring"
#define DEVICE_MODEL     "RingLight-C3"

// -------------------- 硬件配置 (ESP32-C3 / 24灯 / GPIO3) --------------------
#define NUM_LEDS         24          // 圆环灯珠数量
#define LED_PIN          3           // WS2812B DIN -> GPIO3
#define LED_TYPE         WS2812B
#define COLOR_ORDER      GRB

// -------------------- 默认运行时参数 --------------------
#define DEFAULT_BRIGHTNESS  64
#define DEFAULT_SPEED       128
#define DEFAULT_EFFECT      "solid"
#define DEFAULT_COLOR_R     0
#define DEFAULT_COLOR_G     255
#define DEFAULT_COLOR_B     0
#define DEFAULT_POWER       true

// agent init 彩虹持续时间, 到点无新指令则自动关灯
#define INIT_AUTO_OFF_MS    3000UL
// agent idle 呼吸灯持续时间, 到点无新指令则自动关灯
#define IDLE_AUTO_OFF_MS    10000UL

// -------------------- 网络默认 --------------------
#define UDP_PORT            8888
#define HTTP_PORT           80
#define MQTT_PORT           1883
#define MQTT_DEFAULT_TOPIC  "ring"
#define STA_TIMEOUT_MS      10000UL    // STA 连接超时
#define WIFI_RECONN_MS      10000UL    // 断线重连检测间隔

// 代码内默认 WiFi (NVS 无配置时使用; 连接失败 10s 后启动 AP 热点)
#define DEFAULT_WIFI_SSID   ""
#define DEFAULT_WIFI_PASS   ""

// AP 模式默认
#define AP_SSID_PREFIX      "ESP32-Ring-"
#define AP_PASSWORD         ""          // 空 = 开放热点
#define AP_CHANNEL          1

// -------------------- BLE (NimBLE) --------------------
#define BLE_DEVICE_PREFIX   "ESP32-Ring-"
#define BLE_ENABLED         true

// 自定义 128-bit UUID (用随机 base + 后缀)
#define RING_SERVICE_UUID   "8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0"
#define CHAR_COLOR_UUID     "8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0"
#define CHAR_STATE_UUID     "8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0"

// -------------------- Home Assistant 自动发现 --------------------
#define HA_DISCOVERY_PREFIX "homeassistant"
#define HA_NODE_ID          "ring"

// -------------------- mDNS --------------------
#define MDNS_NAME           "ringlight"

// -------------------- NVS 存储 key --------------------
#define NVS_NAMESPACE       "ring"
// settings 区
#define NVS_EFFECT          "efx"
#define NVS_BRIGHTNESS      "brt"
#define NVS_SPEED           "spd"
#define NVS_POWER           "pwr"
#define NVS_COL_R           "r"
#define NVS_COL_G           "g"
#define NVS_COL_B           "b"
#define NVS_COL2_R          "r2"
#define NVS_COL2_G          "g2"
#define NVS_COL2_B          "b2"
// wifi 区
#define NVS_WIFI_SSID       "ssid"
#define NVS_WIFI_PASS       "pass"
// mqtt 区
#define NVS_MQTT_HOST       "mh"
#define NVS_MQTT_PORT       "mp"
#define NVS_MQTT_USER       "mu"
#define NVS_MQTT_PASS       "mpw"
#define NVS_MQTT_ENABLED    "men"
#define NVS_MQTT_TOPIC      "mt"

// -------------------- 智能体状态预设映射 --------------------
// 名称 -> {effect, R, G, B}
// 供 "agent STATE" 文本指令 / HTTP /api/agent 直接调用
// 定义见 effects.cpp 与 command.cpp

#endif // RING_CONFIG_H
