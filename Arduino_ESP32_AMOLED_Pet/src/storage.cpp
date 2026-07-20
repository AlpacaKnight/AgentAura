/*
 * ============================================================
 *  storage.cpp — NVS 配置存储实现 (基于 Preferences)
 *  参考环形灯固件 storage.cpp 架构
 * ============================================================
 */
#include "storage.h"
#include "pin_config.h"

namespace storage {

static Preferences s_prefs;

void begin() {
  s_prefs.begin(NVS_NAMESPACE, false);
}

// ---- WiFi ----
WifiCred loadWifi() {
  WifiCred w;
  String ssid = s_prefs.getString(NVS_WIFI_SSID, "");
  if (ssid.length() > 0) {
    w.valid = true;
    w.ssid  = ssid;
    w.pass  = s_prefs.getString(NVS_WIFI_PASS, "");
  }
  return w;
}

void saveWifi(const String& ssid, const String& pass) {
  s_prefs.putString(NVS_WIFI_SSID, ssid);
  s_prefs.putString(NVS_WIFI_PASS, pass);
}

// ---- MQTT ----
MqttCfg loadMqtt() {
  MqttCfg m;
  m.enabled = s_prefs.getBool(NVS_MQTT_ENABLED, false);
  m.host    = s_prefs.getString(NVS_MQTT_HOST, "");
  m.port    = s_prefs.getUInt(NVS_MQTT_PORT, 1883);
  m.user    = s_prefs.getString(NVS_MQTT_USER, "");
  m.pass    = s_prefs.getString(NVS_MQTT_PASS, "");
  m.topic   = s_prefs.getString(NVS_MQTT_TOPIC, "agentaura");
  return m;
}

void saveMqtt(const MqttCfg& cfg) {
  s_prefs.putBool(NVS_MQTT_ENABLED, cfg.enabled);
  s_prefs.putString(NVS_MQTT_HOST, cfg.host);
  s_prefs.putUInt(NVS_MQTT_PORT, cfg.port);
  s_prefs.putString(NVS_MQTT_USER, cfg.user);
  s_prefs.putString(NVS_MQTT_PASS, cfg.pass);
  s_prefs.putString(NVS_MQTT_TOPIC, cfg.topic);
}

void clearMqtt() {
  s_prefs.remove(NVS_MQTT_ENABLED);
  s_prefs.remove(NVS_MQTT_HOST);
  s_prefs.remove(NVS_MQTT_PORT);
  s_prefs.remove(NVS_MQTT_USER);
  s_prefs.remove(NVS_MQTT_PASS);
  s_prefs.remove(NVS_MQTT_TOPIC);
}

// ---- 设置 ----
void saveBrightness(uint8_t v) {
  s_prefs.putUChar(NVS_BRIGHTNESS, v);
}

uint8_t loadBrightness(uint8_t def) {
  return s_prefs.getUChar(NVS_BRIGHTNESS, def);
}

void saveVolume(uint8_t v) {
  s_prefs.putUChar(NVS_VOLUME, v);
}

uint8_t loadVolume(uint8_t def) {
  return s_prefs.getUChar(NVS_VOLUME, def);
}

void saveBleEnabled(bool enabled) {
  s_prefs.putBool(NVS_BLE_ENABLED, enabled);
}

bool loadBleEnabled(bool def) {
  return s_prefs.getBool(NVS_BLE_ENABLED, def);
}

} // namespace storage
