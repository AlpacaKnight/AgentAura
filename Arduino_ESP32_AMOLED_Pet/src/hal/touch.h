/*
 * ============================================================
 *  hal/touch.h — 触摸屏 HAL (FT3168)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_TOUCH_H
#define AGENTAURA_TOUCH_H

#include <Arduino.h>

namespace hal {

void   touch_init();            // 初始化触摸
bool   touch_available();       // 触摸控制器是否已初始化
bool   touch_read(int16_t* x, int16_t* y);  // 读取触摸坐标 (返回是否有效)
void   touch_set_callback(void (*cb)(int16_t x, int16_t y, bool pressed));

} // namespace hal

#endif // AGENTAURA_TOUCH_H
