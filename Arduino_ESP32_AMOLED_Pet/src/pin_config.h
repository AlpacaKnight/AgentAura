/*
 * ============================================================
 *  pin_config.h — 硬件引脚定义 (Waveshare ESP32-C6-Touch-AMOLED-1.8)
 *  参考: Waveshare 官方 pin_config.h + ESP32-AIChats 板级定义
 *
 *  V1 版: SH8601 (显示) + FT3168 (触摸)
 *  V2 版: CO5300 (显示) + CST816 (触摸)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_PIN_CONFIG_H
#define AGENTAURA_PIN_CONFIG_H

// ==================== 系统信息 ====================
#define XPOWERS_CHIP_AXP2101

// ==================== AMOLED 显示屏 (QSPI) ====================
// V1 版: SH8601 (驱动芯片) | V2 版: CO5300
// 根据你的硬件版本在 build_flags 中加入 -DLCD_DRIVER_SH8601 或 -DLCD_DRIVER_CO5300
#define LCD_SDIO0   1
#define LCD_SDIO1   2
#define LCD_SDIO2   3
#define LCD_SDIO3   4
#define LCD_SCLK    0
#define LCD_CS      5
#define LCD_WIDTH   368
#define LCD_HEIGHT  448

// LCD RST: 通过 TCA9554 EXIO1 控制, 或直接使用 GPIO
// 如果你的硬件使用 GPIO41 作为 RST, 取消下面的注释并注释掉 LCD_RST_PIN_TCA
// #define LCD_RST     41
// 如果使用 TCA9554 GPIO 扩展器控制 RST, 设置为 -1 并确保 tca9554_init() 在 display_init() 之前调用
#define LCD_RST     -1

// ==================== 触摸 FT3168 (I2C) ====================
#define IIC_SDA     8
#define IIC_SCL     7
#define TP_INT      15

// ==================== 音频 ES8311 (I2S + I2C) ====================
#define I2S_MCK_IO  19
#define I2S_BCK_IO  20
#define I2S_DI_IO   21   // I2S data in (mic)
#define I2S_WS_IO   22
#define I2S_DO_IO   23    // I2S data out (speaker)
#define PA_PIN      46   // 功放使能

// 兼容命名
#define MCLKPIN     19
#define BCLKPIN     20
#define WSPIN       22
#define DOPIN       21
#define DIPIN       23
#define PA          PA_PIN

// ES8311 I2C 地址 (复用 I2C 总线: SDA=8, SCL=7)
#define ES8311_ADDR 0x18

// ==================== SD 卡 (SDMMC) ====================
const int SDMMC_CLK  = 2;
const int SDMMC_CMD  = 1;
const int SDMMC_DATA = 3;
// SD_CS 由 TCA9554 EXIO7 控制

// ==================== 按键 ====================
// GPIO0 已用于 LCD QSPI SCLK，不能再配置为按键输入。
// 本板 PWR 键由 AXP2101 管理；没有可供应用轮询的独立 BOOT GPIO。
#define BOOT_BUTTON_GPIO    -1
// PWR 按键 — 右侧，连接到 AXP2101，短按=取消/拒绝，长按6秒=关机
// PWR 由 AXP2101 电源管理芯片处理，在软件中通过 PMU 接口操作

// ==================== I2C 总线 ====================
#define I2C_MASTER_NUM      0           // I2C_NUM_0
#define I2C_MASTER_FREQ_HZ  400000
#define I2C_SDA             IIC_SDA     // GPIO8
#define I2C_SCL             IIC_SCL     // GPIO7

// ==================== TCA9554 GPIO 扩展器 ====================
// 挂在 I2C_NUM_0 总线上, 地址见具体芯片
#define TCA9554_ADDR        0x20
#define TCA9554_PIN_LCD_BL  0           // EXIO0: LCD 背光
#define TCA9554_PIN_SD_CS   7           // EXIO7: SD 卡 CS
#define TCA9554_PIN_LCD_RST 1           // EXIO1: LCD 复位 (部分版本)

// ==================== 固件信息 ====================
#define FW_VERSION          "0.1.0"
#define FW_NAME             "AgentAura"
#define DEVICE_MODEL        "ESP32-C6-AMOLED-PET"
#define MDNS_NAME           "agentaura"

// ==================== 网络默认配置 ====================
#define UDP_PORT            8888
#define HTTP_PORT           80
#define MQTT_PORT           1883
#define MQTT_DEFAULT_TOPIC  "agentaura"
#define STA_TIMEOUT_MS      10000UL
#define WIFI_RECONN_MS      10000UL
#define DEFAULT_WIFI_SSID   ""
#define DEFAULT_WIFI_PASS   ""
#define AP_SSID_PREFIX      "AgentAura-"
#define AP_PASSWORD         ""
#define AP_CHANNEL          1

// ==================== BLE (NimBLE) ====================
#define BLE_DEVICE_PREFIX   "AgentAura-"
#define BLE_ENABLED         true

#define SERVICE_UUID        "8e7f1a01-2b3c-4d5e-9f01-a1b2c3d4e5f0"
#define CHAR_CMD_UUID       "8e7f1a02-2b3c-4d5e-9f01-a1b2c3d4e5f0"
#define CHAR_STATE_UUID     "8e7f1a03-2b3c-4d5e-9f01-a1b2c3d4e5f0"

// ==================== NVS 存储 key ====================
#define NVS_NAMESPACE       "aura"
#define NVS_WIFI_SSID       "ssid"
#define NVS_WIFI_PASS       "pass"
#define NVS_MQTT_HOST       "mh"
#define NVS_MQTT_PORT       "mp"
#define NVS_MQTT_USER       "mu"
#define NVS_MQTT_PASS       "mpw"
#define NVS_MQTT_ENABLED    "men"
#define NVS_MQTT_TOPIC      "mt"
#define NVS_BRIGHTNESS      "brt"
#define NVS_VOLUME          "vol"
#define NVS_BLE_ENABLED     "ble"
#define NVS_WIFI_ENABLED    "wifi"
#define NVS_PET_STATE       "pet"

// ==================== 宠物默认 ====================
#define DEFAULT_BRIGHTNESS  200
#define DEFAULT_VOLUME      50
#define DEFAULT_BLE_EN      true
#define DEFAULT_WIFI_EN     true

#endif // AGENTAURA_PIN_CONFIG_H
