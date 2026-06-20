/*
 * ============================================================
 *  command.h — 统一指令解析器
 *  所有连接方式 (USB/UDP/MQTT/BLE) 共用文本入口;
 *  HTTP/MQTT JSON 共用 JSON 入口.
 * ============================================================
 */
#pragma once
#ifndef RING_COMMAND_H
#define RING_COMMAND_H

#include <Arduino.h>
#include <ArduinoJson.h>

namespace cmd {

// 处理一行文本指令 (USB/UDP/MQTT/BLE 通用).
// resp 可为 nullptr (默认回写到 Serial).
// 返回响应字符串, 调用方可发送给对端.
String handleText(const String& line);

// JSON 入口 (HTTP POST / MQTT JSON 载荷)
// payload 例: {"r":255,"g":0,"b":0}
String handleColorJson(const String& payload);
// {"effect":"breath","r":0,"g":255,"b":0,"r2":..,"g2":..,"b2":..,"speed":..,"brightness":..}
String handleEffectJson(const String& payload);
// {"value":128}
String handleBrightnessJson(const String& payload);
String handleSpeedJson(const String& payload);

// 智能体状态映射 (§5): 输入状态名 (如 "idle"/"busy"/"error"/"init" ...)
// 设置对应 effect+color 并保存. 不识别返回 false.
bool handleAgentState(const String& stateName);

// 应用当前 state 到 LED + 持久化 (内部调用)
void applyAndSave();

} // namespace cmd

#endif // RING_COMMAND_H
