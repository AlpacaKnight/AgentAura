/*
 * ============================================================
 *  hal/display.h — AMOLED 显示屏 HAL
 *  SH8601 QSPI 驱动 (通过 GFX_Library_for_Arduino)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_DISPLAY_H
#define AGENTAURA_DISPLAY_H

#include <Arduino.h>
#include <Arduino_GFX_Library.h>

namespace hal {

extern Arduino_GFX* gfx;   // 使用基类指针，兼容 SH8601 和 CO5300

void display_init();        // 初始化 AMOLED 显示屏
void display_set_brightness(uint8_t level);  // 设置亮度 0-255
void display_on();          // 开屏
void display_off();         // 关屏 (省电)
void display_set_rotation(uint8_t r);

} // namespace hal

#endif // AGENTAURA_DISPLAY_H