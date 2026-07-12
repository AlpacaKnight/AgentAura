/*
 * ============================================================
 *  hal/pmu.cpp 鈥?鐢垫簮绠＄悊瀹炵幇 (AXP2101)
 *  閫傞厤 XPowersLib v0.3.4 API
 * ============================================================
 */
#include "hal/pmu.h"
#include "pin_config.h"
#include <XPowersLib.h>
#include <Wire.h>

namespace hal {

static XPowersAXP2101 s_pmu;

void pmu_init() {
  Wire.begin(IIC_SDA, IIC_SCL);

  if (!s_pmu.begin(Wire, AXP2101_SLAVE_ADDRESS, IIC_SDA, IIC_SCL)) {
    Serial.println(F("[pmu] AXP2101 init FAILED!"));
    return;
  }

  // 璁剧疆 DC-DC 杈撳嚭鐢靛帇
  s_pmu.setDC1Voltage(3300);  // 3.3V
  s_pmu.setDC2Voltage(1800);  // 1.8V
  s_pmu.setDC3Voltage(3300);  // 3.3V

  // 浣胯兘杈撳嚭閫氶亾
  s_pmu.enableDC1();
  s_pmu.enableDC2();
  s_pmu.enableDC3();
  s_pmu.enableALDO1();  // 鐢ㄤ簬 LCD
  s_pmu.enableALDO2();  // 鐢ㄤ簬瑙︽懜
  s_pmu.enableALDO3();  // 鐢ㄤ簬 SD 鍗?
  s_pmu.enableALDO4();  // 鐢ㄤ簬闊抽

  // 璁剧疆鍏呯數鐢垫祦
  s_pmu.setChargerTerminationCurr(XPOWERS_AXP2101_CHG_ITERM_100MA);
  s_pmu.setChargerConstantCurr(XPOWERS_AXP2101_CHG_CUR_500MA);

  // 鍚敤鎸夐敭锛堥暱鎸夊叧鏈猴級
  s_pmu.setPowerKeyPressOffTime(XPOWERS_POWEROFF_6S);
  s_pmu.setPowerKeyPressOnTime(XPOWERS_POWERON_128MS);

  Serial.println(F("[pmu] AXP2101 init OK"));
}

bool pmu_get_charging() {
  return s_pmu.isCharging();
}

uint8_t pmu_get_battery_level() {
  return s_pmu.getBatteryPercent();
}

float pmu_get_battery_voltage() {
  return s_pmu.getBattVoltage() / 1000.0f;
}

void pmu_power_off() {
  Serial.println(F("[pmu] power off requested"));
  s_pmu.shutdown();
}

bool pmu_is_pwr_btn_pressed() {
  return s_pmu.isPekeyShortPressIrq();
}

} // namespace hal
