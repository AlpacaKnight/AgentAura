/*
 * ============================================================
 *  storage.cpp — NVS 持久化 (Preferences)
 * ============================================================
 */
#include "storage.h"
#include "config.h"
#include "state.h"
#include "effects.h"
#include <Preferences.h>

namespace storage {

static Preferences prefs;

void begin() {
  prefs.begin(NVS_NAMESPACE, false);
}

void loadSettings() {
  // 若 key 不存在则用 config.h 默认值
  uint8_t efx = prefs.getUChar(NVS_EFFECT, EFX_SOLID);
  if (efx >= EFX_COUNT) efx = EFX_SOLID;
  state.effect     = (EffectType)efx;
  state.brightness = prefs.getUChar(NVS_BRIGHTNESS, DEFAULT_BRIGHTNESS);
  state.speed      = prefs.getUChar(NVS_SPEED, DEFAULT_SPEED);
  state.power      = prefs.getBool(NVS_POWER, DEFAULT_POWER);
  uint8_t r = prefs.getUChar(NVS_COL_R, DEFAULT_COLOR_R);
  uint8_t g = prefs.getUChar(NVS_COL_G, DEFAULT_COLOR_G);
  uint8_t b = prefs.getUChar(NVS_COL_B, DEFAULT_COLOR_B);
  state.color1 = CRGB(r, g, b);
  uint8_t r2 = prefs.getUChar(NVS_COL2_R, 0);
  uint8_t g2 = prefs.getUChar(NVS_COL2_G, 0);
  uint8_t b2 = prefs.getUChar(NVS_COL2_B, 255);
  state.color2 = CRGB(r2, g2, b2);
}

WifiCred loadWifi() {
  WifiCred w;
  String ssid = prefs.getString(NVS_WIFI_SSID, "");
  String pass = prefs.getString(NVS_WIFI_PASS, "");
  if (ssid.length() > 0) {
    w.ssid = ssid;
    w.pass = pass;
    w.valid = true;
  }
  return w;
}

MqttCfg loadMqtt() {
  MqttCfg m;
  m.host    = prefs.getString(NVS_MQTT_HOST, "");
  m.port    = (uint16_t)prefs.getUInt(NVS_MQTT_PORT, MQTT_PORT);
  m.user    = prefs.getString(NVS_MQTT_USER, "");
  m.pass    = prefs.getString(NVS_MQTT_PASS, "");
  m.enabled = prefs.getBool(NVS_MQTT_ENABLED, false);
  m.topic   = prefs.getString(NVS_MQTT_TOPIC, MQTT_DEFAULT_TOPIC);
  return m;
}

void saveSettings() {
  prefs.putUChar(NVS_EFFECT, (uint8_t)state.effect);
  prefs.putUChar(NVS_BRIGHTNESS, state.brightness);
  prefs.putUChar(NVS_SPEED, state.speed);
  prefs.putBool(NVS_POWER, state.power);
  prefs.putUChar(NVS_COL_R, state.color1.r);
  prefs.putUChar(NVS_COL_G, state.color1.g);
  prefs.putUChar(NVS_COL_B, state.color1.b);
  prefs.putUChar(NVS_COL2_R, state.color2.r);
  prefs.putUChar(NVS_COL2_G, state.color2.g);
  prefs.putUChar(NVS_COL2_B, state.color2.b);
}

void saveWifi(const String& ssid, const String& pass) {
  prefs.putString(NVS_WIFI_SSID, ssid);
  prefs.putString(NVS_WIFI_PASS, pass);
}

void saveMqtt(const MqttCfg& cfg) {
  prefs.putString(NVS_MQTT_HOST, cfg.host);
  prefs.putUInt(NVS_MQTT_PORT, cfg.port);
  prefs.putString(NVS_MQTT_USER, cfg.user);
  prefs.putString(NVS_MQTT_PASS, cfg.pass);
  prefs.putBool(NVS_MQTT_ENABLED, cfg.enabled);
  prefs.putString(NVS_MQTT_TOPIC, cfg.topic);
}

void clearMqtt() {
  prefs.remove(NVS_MQTT_HOST);
  prefs.remove(NVS_MQTT_PORT);
  prefs.remove(NVS_MQTT_USER);
  prefs.remove(NVS_MQTT_PASS);
  prefs.remove(NVS_MQTT_ENABLED);
  prefs.remove(NVS_MQTT_TOPIC);
}

void reset() {
  // 保留 wifi, 清其它
  prefs.remove(NVS_EFFECT);
  prefs.remove(NVS_BRIGHTNESS);
  prefs.remove(NVS_SPEED);
  prefs.remove(NVS_POWER);
  prefs.remove(NVS_COL_R);
  prefs.remove(NVS_COL_G);
  prefs.remove(NVS_COL_B);
  prefs.remove(NVS_COL2_R);
  prefs.remove(NVS_COL2_G);
  prefs.remove(NVS_COL2_B);
  clearMqtt();
  loadSettings();
}

void factoryReset() {
  prefs.clear();
  loadSettings();
}

} // namespace storage
