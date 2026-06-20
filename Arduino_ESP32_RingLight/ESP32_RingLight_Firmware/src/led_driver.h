/*
 * ============================================================
 *  led_driver.h — FastLED 驱动 + 效果调度器
 * ============================================================
 */
#pragma once
#ifndef RING_LED_DRIVER_H
#define RING_LED_DRIVER_H

#include <Arduino.h>

namespace ledDriver {

void begin();        // FastLED 初始化 + 应用初始亮度 + 单帧绘制
void loop();         // 按 state.speed 推进步长并绘制
void showFrame();    // 强制立即绘制一帧并 show()
void clear();        // 全黑

// speed(0-255) -> 推进间隔(ms). speed 越大越快.
unsigned long intervalForSpeed(uint8_t s);

} // namespace ledDriver

#endif // RING_LED_DRIVER_H
