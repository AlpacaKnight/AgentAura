/*
 * ============================================================
 *  storage.h — NVS 配置存储 (基于 Preferences)
 *  参考环形灯固件 storage.h/cpp 架构
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_STORAGE_H
#define AGENTAURA_STORAGE_H

#include <Arduino.h>
#include <Preferences.h>

namespace storage {

void begin();

// WiFi
struct WifiCred {
  bool   valid = false;
  String ssid;
  String pass;
};
WifiCred loadWifi();
void     saveWifi(const String& ssid, const String& pass);

// MQTT
struct MqttCfg {
  bool     enabled  = false;
  String   host;
  uint16_t port     = 1883;
  String   user;
  String   pass;
  String   topic    = "agentaura";
};
MqttCfg loadMqtt();
void     saveMqtt(const MqttCfg& cfg);
void     clearMqtt();

// 设置
void     saveBrightness(uint8_t v);
uint8_t  loadBrightness(uint8_t def);
void     saveVolume(uint8_t v);
uint8_t  loadVolume(uint8_t def);

} // namespace storage

#endif // AGENTAURA_STORAGE_H