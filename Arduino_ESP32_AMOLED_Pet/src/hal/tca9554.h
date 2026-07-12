/*
 * ============================================================
 *  hal/tca9554.h — TCA9554 GPIO 扩展器 HAL
 *  用于控制 LCD RST, 背光, SD CS 等
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_TCA9554_H
#define AGENTAURA_TCA9554_H

#include <Arduino.h>

namespace hal {

// 初始化 TCA9554 GPIO 扩展器
bool tca9554_init();

// 设置输出引脚
void tca9554_write_pin(uint8_t pin, bool state);

// 读取输入引脚
bool tca9554_read_pin(uint8_t pin);

// LCD 复位脉冲
void tca9554_lcd_reset();

} // namespace hal

#endif // AGENTAURA_TCA9554_H
