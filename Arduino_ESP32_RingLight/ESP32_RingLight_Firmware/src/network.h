/*
 * ============================================================
 *  network.h — WiFi STA/AP 管理 + 配置页路由 + mDNS
 * ============================================================
 */
#pragma once
#ifndef RING_NETWORK_H
#define RING_NETWORK_H

#include <Arduino.h>

namespace net {

enum Mode : uint8_t { MODE_NONE = 0, MODE_STA = 1, MODE_AP = 2 };
extern Mode currentMode;

void begin();
void loop();               // STA 模式断线重连

bool isSTA();              // 当前是否 STA 已连接
bool isAP();
String ipString();         // 当前 IP (字符串)
String ssidString();       // 当前 SSID (AP 模式返回 AP_SSID)
int    rssi();

// 给 state JSON 的 connections 段使用
String connectionsJson();

// 触发重启 (例如配网保存后)
void requestRestart();

} // namespace net

#endif // RING_NETWORK_H
