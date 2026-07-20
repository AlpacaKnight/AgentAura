/*
 * ============================================================
 *  state.cpp — 全局运行时状态 + §9 统一 JSON
 * ============================================================
 */
#include "state.h"
#include "config.h"
#include "led_driver.h"
#include "effects.h"
#include "network.h"
#include <ArduinoJson.h>

RuntimeState state;
ConnectionFlags conn;

void setCurrentEffect(EffectType e) {
  if (e == EFX_INVALID || e >= EFX_COUNT) return;
  if (state.effect != e) {
    resetEffect(e);
  }
  state.effect = e;
  ledDriver::showFrame();
}

void setCurrentColor(uint8_t r, uint8_t g, uint8_t b) {
  state.color1 = CRGB(r, g, b);
  ledDriver::showFrame();
}

void setCurrentColor2(uint8_t r, uint8_t g, uint8_t b) {
  state.color2 = CRGB(r, g, b);
  ledDriver::showFrame();
}

void setCurrentBrightness(uint8_t v) {
  state.brightness = v;
  ledDriver::showFrame();
}

void setCurrentSpeed(uint8_t v) {
  state.speed = v;
}

void setPower(bool on) {
  state.power = on;
  ledDriver::showFrame();
}

// ============================================================
//               自动关灯定时 (agent init 彩虹 3 秒后关闭)
// ============================================================
static unsigned long sAutoOffDeadline = 0;   // 0 = 无等待中的定时
static bool          sAutoOffActive  = false;

void scheduleAutoOff(unsigned long ms) {
  sAutoOffDeadline = millis() + ms;
  sAutoOffActive   = true;
}

void cancelAutoOff() {
  sAutoOffActive  = false;
  sAutoOffDeadline = 0;
}

bool isAutoOffPending() {
  return sAutoOffActive;
}

bool tickAutoOff() {
  if (!sAutoOffActive) return false;
  if (millis() < sAutoOffDeadline) return false;
  // 到点: 关灯 (内部会 showFrame 一次输出黑屏)
  sAutoOffActive = false;
  sAutoOffDeadline = 0;
  setPower(false);
  return true;
}

// 生成统一状态 JSON (§9)
String getStateJson() {
  JsonDocument doc;
  doc["device"]   = FW_NAME;
  doc["firmware"] = FW_VERSION;
  doc["uptime"]   = (uint32_t)(millis() / 1000UL);

  JsonObject wifi = doc["wifi"].to<JsonObject>();
  wifi["connected"] = net::isSTA();
  wifi["ssid"]      = net::ssidString();
  wifi["rssi"]      = net::rssi();
  wifi["ip"]        = net::ipString();
  wifi["mode"]      = net::isAP() ? "AP" : (net::isSTA() ? "STA" : "none");

  JsonObject led = doc["led"].to<JsonObject>();
  led["num_leds"]   = NUM_LEDS;
  led["brightness"] = state.brightness;
  led["speed"]      = state.speed;
  led["power"]      = state.power;

  JsonObject cur = doc["current"].to<JsonObject>();
  cur["effect"] = effectName(state.effect);
  JsonObject col = cur["color"].to<JsonObject>();
  col["r"] = state.color1.r;
  col["g"] = state.color1.g;
  col["b"] = state.color1.b;
  JsonObject col2 = cur["color2"].to<JsonObject>();
  col2["r"] = state.color2.r;
  col2["g"] = state.color2.g;
  col2["b"] = state.color2.b;

  JsonObject c = doc["connections"].to<JsonObject>();
  c["usb"]  = conn.usb;
  c["http"] = conn.http;
  c["udp"]  = conn.udp;
  c["mqtt"] = conn.mqtt;
  c["ble"]  = conn.ble;
  c["ble_running"] = state.ble_running;

  JsonObject settings = doc["settings"].to<JsonObject>();
  settings["ble_enabled"] = state.ble_enabled;

  String out;
  serializeJson(doc, out);
  return out;
}
