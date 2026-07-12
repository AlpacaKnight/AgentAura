/*
 * ============================================================
 *  comm/comm_manager.h — 通信多路管理器
 *  聚合 USB/BLE/WiFi(HTTP/UDP/WS/MQTT) 各通道
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_COMM_MANAGER_H
#define AGENTAURA_COMM_MANAGER_H

#include <Arduino.h>

namespace comm {

void comm_begin();      // 初始化所有通信通道
void comm_loop();       // 轮询所有通道
void comm_broadcast(const String& data);  // 广播到所有已连接的通道

} // namespace comm

#endif // AGENTAURA_COMM_MANAGER_H