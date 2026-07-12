/*
 * ============================================================
 *  hal/pmu.h — 电源管理 HAL (AXP2101)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_PMU_H
#define AGENTAURA_PMU_H

#include <Arduino.h>

namespace hal {

void pmu_init();                // 初始化 PMU

bool pmu_get_charging();        // 是否在充电
uint8_t pmu_get_battery_level();  // 电池电量百分比
float pmu_get_battery_voltage();  // 电池电压

void pmu_power_off();           // 关机
bool pmu_is_pwr_btn_pressed();  // PWR 按键是否按下

} // namespace hal

#endif // AGENTAURA_PMU_H