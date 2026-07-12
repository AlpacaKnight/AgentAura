/*
 * ============================================================
 *  comm/ble_server.h — BLE GATT 服务
 *  自定义 Service: 控制指令 + 状态回传
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_BLE_SERVER_H
#define AGENTAURA_BLE_SERVER_H

#include <Arduino.h>

namespace comm {

void ble_begin();           // 启动 BLE 服务
void ble_loop();            // 轮询
void ble_stop();            // 停止 BLE
void ble_toggle(bool on);   // 开关 BLE

bool ble_is_connected();    // 是否有 BLE 客户端连接
bool ble_is_running();      // BLE 是否在运行

// 发送消息到BLE客户端
void ble_send(const String& data);

} // namespace comm

#endif // AGENTAURA_BLE_SERVER_H