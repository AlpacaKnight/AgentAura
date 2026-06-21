/*
 * ============================================================
 *  led_driver.cpp — FastLED 初始化 + 按速度调度绘制
 * ============================================================
 */
#include "led_driver.h"
#include "config.h"
#include "state.h"
#include "effects.h"
#include <FastLED.h>

namespace ledDriver {

static unsigned long sLastTick = 0;

void begin() {
  FastLED.addLeds<LED_TYPE, LED_PIN, COLOR_ORDER>(leds, NUM_LEDS);
  FastLED.setBrightness(state.brightness);
  FastLED.clear();
  FastLED.show();
  sLastTick = millis();
}

unsigned long intervalForSpeed(uint8_t s) {
  // s=0 -> 500ms (慢), s=255 -> 20ms (快)
  // 对数映射, 人眼感觉更线性
  // 用 (256 - s) * k, 再 clamp
  unsigned long v = (unsigned long)(256u - s) * 500UL / 256UL + 20UL;
  if (v < 20UL)  v = 20UL;
  if (v > 500UL) v = 500UL;
  return v;
}

void showFrame() {
  if (!state.power) {
    FastLED.clear();
    FastLED.show();
    return;
  }
  FastLED.setBrightness(state.brightness);
  drawEffect(state.effect, state.color1, state.color2);
  FastLED.show();
}

void loop() {
  // 自动关灯定时 (agent init 彩虹 3 秒后): 到点则关灯并跳过本帧动画
  if (tickAutoOff()) {
    return;
  }

  unsigned long now = millis();
  unsigned long interval = intervalForSpeed(state.speed);
  if (now - sLastTick >= interval) {
    sLastTick = now;
    animStep++;
    showFrame();
  }
}

void clear() {
  FastLED.clear();
  FastLED.show();
}

} // namespace ledDriver
