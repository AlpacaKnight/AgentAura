/*
 * ============================================================
 *  storage.h — NVS 持久化 (Preferences 封装)
 * ============================================================
 */
#pragma once
#ifndef RING_STORAGE_H
#define RING_STORAGE_H

#include <Arduino.h>
#include "config.h"

struct WifiCred { String ssid, pass; bool valid = false; };
struct MqttCfg  {
  String  host;
  uint16_t port = MQTT_PORT;
  String  user, pass;
  bool    enabled = false;
  String  topic   = MQTT_DEFAULT_TOPIC;
};

namespace storage {

void begin();                 // 打开 namespace
void loadSettings();          // 载入 effect/color/brightness/speed/power 到 state
WifiCred loadWifi();
MqttCfg  loadMqtt();

void saveSettings();          // 保存 state.* 到 NVS
void saveWifi(const String& ssid, const String& pass);
void saveMqtt(const MqttCfg& cfg);
void clearMqtt();             // 清空 mqtt 配置

void reset();                 // 清空除 wifi 外全部设置, 恢复默认
void factoryReset();          // 清空所有, 包括 wifi

} // namespace storage

#endif // RING_STORAGE_H
