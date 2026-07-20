/*
 * ============================================================
 *  hal/buttons.h — 物理按键管理 HAL
 *
 *  左侧 BOOT 按钮: 短按=语音开始/停止, 长按=待定
 *  右侧 PWR 按钮: 短按=取消/审批拒绝, 长按6秒=关机 (由AXP2101处理)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_BUTTONS_H
#define AGENTAURA_BUTTONS_H

#include <Arduino.h>

namespace hal {

// 按键事件回调
typedef void (*ButtonCallback)();

void buttons_init();                    // 初始化按键

// BOOT 按键回调
void on_boot_short_press(ButtonCallback cb);
void on_boot_long_press(ButtonCallback cb);

// PWR 按键回调 (由 AXP2101 管理, 这里仅短按检测)
void on_pwr_short_press(ButtonCallback cb);

void buttons_loop();                    // 在 loop 中轮询

} // namespace hal

#endif // AGENTAURA_BUTTONS_H