/*
 * ============================================================
 *  effects.h — 15 种灯效定义
 * ============================================================
 */
#pragma once
#ifndef RING_EFFECTS_H
#define RING_EFFECTS_H

#include <FastLED.h>
#include "config.h"

// 15 种效果枚举 (顺序与需求文档一致)
enum EffectType : uint8_t {
  EFX_SOLID     = 0,
  EFX_BREATH    = 1,
  EFX_FLOW      = 2,
  EFX_RAINBOW   = 3,
  EFX_GRADIENT  = 4,
  EFX_BLINK     = 5,
  EFX_FIRE      = 6,
  EFX_SPARKLE   = 7,
  EFX_CYCLE     = 8,
  EFX_METEOR    = 9,
  EFX_BOUNCE    = 10,
  EFX_WAVE      = 11,
  EFX_PULSE     = 12,
  EFX_FADE      = 13,
  EFX_RANDOM    = 14,
  EFX_COUNT     = 15,
  EFX_INVALID   = 0xFF
};

// 共享 LED 缓冲 (led_driver 初始化, effects 操作)
extern CRGB leds[NUM_LEDS];

// 动画推进计数 (各效果共用)
extern uint16_t animStep;

// 名称 <-> 枚举互转 (大小写不敏感)
EffectType  effectFromName(const String& name);
const char* effectName(EffectType e);

// 单帧绘制: 根据 effectType 调用对应效果
void drawEffect(EffectType e, const CRGB& c1, const CRGB& c2);

// 当 effect 切换时调用 (复位临时状态, 如 fire palette / meteor 拖尾)
void resetEffect(EffectType e);

// 复位动画步进
void resetAnimStep();

// RANDOM 效果内部使用: 每隔一段时间随机切换到其它效果
void tickRandomEffect();

#endif // RING_EFFECTS_H
