/*
 * ============================================================
 *  comm/wifi_manager.h — WiFi STA/AP 管理模块
 *  参考环形灯固件 network.h/cpp 架构
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_WIFI_MANAGER_H
#define AGENTAURA_WIFI_MANAGER_H

#include <Arduino.h>

namespace comm {

void wifi_begin();          // 初始化：尝试 STA, 失败则 AP
void wifi_loop();           // 轮询：配网页 + 断线重连

bool wifi_is_sta();         // 是否 STA 模式且已连接
bool wifi_is_ap();          // 是否 AP 模式
bool wifi_is_connected();   // 是否有网络连接

String wifi_ip();           // 当前 IP
String wifi_ssid();         // 当前连接的 SSID
int8_t wifi_rssi();         // 信号强度
String wifi_scan_json();     // WiFi 扫描结果 JSON
String wifi_state_json();    // 网络状态 JSON

void wifi_connect(const String& ssid, const String& pass);  // 手动连接
void wifi_disconnect();      // 断开连接
void wifi_toggle(bool on);   // 开关 WiFi

} // namespace comm

#endif // AGENTAURA_WIFI_MANAGER_H