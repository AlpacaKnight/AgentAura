/*
 * ============================================================
 *  mqtt_client.h — MQTT 客户端 + Home Assistant 自动发现
 * ============================================================
 */
#pragma once
#ifndef RING_MQTT_CLIENT_H
#define RING_MQTT_CLIENT_H

#include <Arduino.h>

namespace mqttClient {

void begin();
void loop();

bool isEnabled();         // NVS 是否启用 MQTT
bool isConnected();

void publishStatus();     // 上报当前状态到 <topic>/status

} // namespace mqttClient

#endif // RING_MQTT_CLIENT_H
