/*
 * ============================================================
 *  ESP32 圆环灯板全能固件 v1.0 — 主程序
 *  目标硬件: ESP32-C3 + WS2812B 圆环 24 灯 (DIN=GPIO3)
 *
 *  连接方式: USB 串口 / WiFi HTTP / WiFi UDP / WiFi MQTT / BLE
 *  灯效: 15 种 (solid/breath/flow/rainbow/gradient/blink/fire/
 *        sparkle/cycle/meteor/bounce/wave/pulse/fade/random)
 *
 *  统一指令格式 (USB/UDP/MQTT/BLE 同一套文本指令):
 *    rgb R,G,B
 *    effect NAME [params]
 *    brightness N
 *    speed N
 *    power on|off
 *    state
 *    reset
 *    wifi SSID,PASSWORD
 *    agent STATE   (running/busy/waiting/error/idle/init/offline/upgrade)
 *    help
 *
 *  上电: 读 NVS 恢复上次状态; 有效 wifi 则 STA, 否则 AP 配置页.
 *  USB-CDC: 直接接串口指令 (C3 板自带 USB-CDC).
 * ============================================================
 */
#include <Arduino.h>
#include "config.h"
#include "state.h"
#include "effects.h"
#include "storage.h"
#include "led_driver.h"
#include "command.h"
#include "network.h"
#include "http_api.h"
#include "udp_cmd.h"
#include "mqtt_client.h"
#include "ble_server.h"

// ---------- USB 串口行缓冲 ----------
static String sSerialBuf;
static void pollSerial() {
  while (Serial.available()) {
    int ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      sSerialBuf.trim();
      if (sSerialBuf.length() > 0) {
        String resp = cmd::handleText(sSerialBuf);
        if (resp.length() > 0) {
          Serial.println(resp);
        }
      }
      sSerialBuf = "";
    } else {
      if (sSerialBuf.length() < 200) sSerialBuf += (char)ch;
    }
  }
}

static void printBanner() {
  Serial.println();
  Serial.println(F("========================================"));
  Serial.print  (F("  ")); Serial.print(FW_NAME);
  Serial.print  (F(" v")); Serial.println(FW_VERSION);
  Serial.print  (F("  ")); Serial.println(DEVICE_MODEL);
  Serial.print  (F("  LEDs: ")); Serial.print(NUM_LEDS);
  Serial.print  (F("  PIN: "));  Serial.println(LED_PIN);
  Serial.println(F("========================================"));
}

// ---------- 启动动画: 绿色跑马灯循环 3 次后关灯 ----------
static void startupAnimation() {
  const CRGB green(0, 255, 0);
  FastLED.setBrightness(180);
  Serial.println(F("[main] startup animation..."));
  // 3 圈, 每圈 NUM_LEDS 步
  for (uint16_t round = 0; round < 3; round++) {
    for (uint16_t i = 0; i < NUM_LEDS; i++) {
      fadeToBlackBy(leds, NUM_LEDS, 80);   // 拖尾衰减
      leds[i] = green;
      FastLED.show();
      delay(45);                            // 跑马灯节奏
    }
  }
  // 关灯, 等待命令
  FastLED.clear();
  FastLED.show();
  Serial.println(F("[main] animation done, lights off, waiting for commands"));
}

void setup() {
  Serial.begin(115200);
  delay(150);
  printBanner();

  // 1. NVS
  storage::begin();
  storage::loadSettings();
  Serial.print(F("[main] effect="));   Serial.print(effectName(state.effect));
  Serial.print(F(" brt=")); Serial.print(state.brightness);
  Serial.print(F(" spd=")); Serial.println(state.speed);
  Serial.flush(); delay(200);

  // 2. LED 驱动 + 启动动画 (绿色跑马灯 3 圈) + 关灯等待命令
  ledDriver::begin();
  startupAnimation();
  // 恢复用户亮度, 但保持关灯状态 (power=false 仅运行时, 不存 NVS)
  FastLED.setBrightness(state.brightness);
  state.power = false;
  // 收到 rgb/effect/agent 等指令时 command.cpp 会自动唤醒
  conn.usb = true;
  Serial.println(F("[main] LED init done"));
  Serial.flush(); delay(200);

  // 3. 网络 (STA 或 AP 配置页)
  Serial.println(F("[main] >>> network begin..."));
  Serial.flush();
  net::begin();
  Serial.println(F("[main] <<< network done"));
  Serial.flush(); delay(200);

  // 4. 若 STA 成功, 启用 HTTP/UDP/MQTT
  if (net::isSTA()) {
    Serial.println(F("[main] STA ok, starting http/udp/mqtt..."));
    Serial.flush();
    httpApi::begin();
    conn.http = true;
    udpCmd::begin();
    mqttClient::begin();
    Serial.println(F("[main] http/udp/mqtt started"));
    Serial.flush(); delay(200);
  } else {
    Serial.println(F("[main] AP mode only"));
    Serial.flush(); delay(200);
  }

  // 5. BLE (编译期开关控制)
#if BLE_ENABLED
  Serial.println(F("[main] >>> BLE begin..."));
  Serial.flush();
  bleServer::begin();
  Serial.println(F("[main] <<< BLE done"));
  Serial.flush(); delay(200);
#endif

  Serial.println(F("[main] setup done. type 'help' for commands."));
  Serial.flush();
}

void loop() {
  pollSerial();              // USB-CDC
  net::loop();               // 配置页 / 重连
  if (conn.http) httpApi::loop();
  if (conn.udp)  udpCmd::loop();
  if (mqttClient::isEnabled()) mqttClient::loop();
  ledDriver::loop();         // 灯效推进
  bleServer::loop();         // NimBLE 维护 (内部空)
}
