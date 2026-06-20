/*
 * ============================================================
 *  state.h — 全局运行时状态
 * ============================================================
 */
#pragma once
#ifndef RING_STATE_H
#define RING_STATE_H

#include <FastLED.h>
#include "effects.h"

struct RuntimeState {
  EffectType effect   = EFX_SOLID;
  CRGB       color1   = CRGB(DEFAULT_COLOR_R, DEFAULT_COLOR_G, DEFAULT_COLOR_B);
  CRGB       color2   = CRGB(0, 0, 255);   // 双色效果第二色
  uint8_t    brightness = DEFAULT_BRIGHTNESS;
  uint8_t    speed    = DEFAULT_SPEED;
  bool       power    = DEFAULT_POWER;
};

extern RuntimeState state;

// 各连接方式是否激活 (供 state JSON 的 connections 字段使用)
struct ConnectionFlags {
  bool usb  = false;
  bool http = false;
  bool udp  = false;
  bool mqtt = false;
  bool ble  = false;
};
extern ConnectionFlags conn;

// 生成 §9 统一状态 JSON
String getStateJson();

// 设置当前效果 (复位动画 + 重绘 + 不保存, 由调用方按需 storage.save)
void setCurrentEffect(EffectType e);
// 设置颜色 (主色)
void setCurrentColor(uint8_t r, uint8_t g, uint8_t b);
void setCurrentColor2(uint8_t r, uint8_t g, uint8_t b);
// 亮度 / 速度 / 电源
void setCurrentBrightness(uint8_t v);
void setCurrentSpeed(uint8_t v);
void setPower(bool on);

#endif // RING_STATE_H
