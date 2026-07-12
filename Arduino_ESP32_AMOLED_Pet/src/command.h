/*
 * ============================================================
 *  command.h — 统一指令解析器
 *  参考环形灯固件 command.h/cpp 架构
 *  支持 USB/UDP/WebSocket/BLE 统一文本协议 + JSON 协议
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_COMMAND_H
#define AGENTAURA_COMMAND_H

#include <Arduino.h>

namespace cmd {

// 处理文本指令 (来自USB/UDP/WebSocket/BLE)
String handleText(const String& cmd);

// 处理JSON指令 (来自WebSocket/HTTP/MQTT)
String handleJson(const String& json_str);

// 返回帮助文本
String getHelp();

} // namespace cmd

#endif // AGENTAURA_COMMAND_H