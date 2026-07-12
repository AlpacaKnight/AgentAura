/*
 * ============================================================
 *  hal/touch.cpp — 触摸屏实现 (FT3168 over I2C)
 * ============================================================
 */
#include "hal/touch.h"
#include "pin_config.h"
#include <Wire.h>

namespace hal {

#define FT3168_ADDR 0x38
#define FT3168_REG_DATA 0x02  // 触摸数据寄存器
#define FT3168_REG_MODE 0x00  // 模式寄存器

static void (*s_touch_cb)(int16_t x, int16_t y, bool pressed) = nullptr;
static bool s_touch_initialized = false;

static bool ft3168_write_reg(uint8_t reg, uint8_t data) {
  Wire.beginTransmission(FT3168_ADDR);
  Wire.write(reg);
  Wire.write(data);
  return Wire.endTransmission() == 0;
}

static bool ft3168_read_regs(uint8_t reg, uint8_t* buf, uint8_t len) {
  Wire.beginTransmission(FT3168_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  Wire.requestFrom(FT3168_ADDR, (int)len);
  for (uint8_t i = 0; i < len; i++) {
    if (!Wire.available()) return false;
    buf[i] = Wire.read();
  }
  return true;
}

void touch_init() {
  // I2C 已在 pmu_init() 中初始化, 这里不再重复调用 Wire.begin()
  pinMode(TP_INT, INPUT_PULLUP);

  delay(50);

  // 检查设备
  uint8_t chip_id = 0;
  if (ft3168_read_regs(0xA3, &chip_id, 1)) {
    Serial.print(F("[touch] FT3168 chip ID: 0x"));
    Serial.println(chip_id, HEX);
  } else {
    Serial.println(F("[touch] FT3168 not found!"));
    return;
  }

  // 设置设备模式为正常
  ft3168_write_reg(FT3168_REG_MODE, 0x00);

  s_touch_initialized = true;
  Serial.println(F("[touch] init OK"));
}

bool touch_available() {
  // 检查 INT 引脚是否为低 (表示有触摸)
  return s_touch_initialized && (digitalRead(TP_INT) == LOW);
}

bool touch_read(int16_t* x, int16_t* y) {
  if (!s_touch_initialized) return false;
  if (digitalRead(TP_INT) != LOW) return false;

  uint8_t data[6] = {0};
  if (!ft3168_read_regs(FT3168_REG_DATA, data, 6)) return false;

  uint8_t touch_points = data[0] & 0x0F;
  if (touch_points == 0) {
    if (s_touch_cb) s_touch_cb(0, 0, false);
    return false;
  }

  // 第一个触摸点
  *x = ((int16_t)(data[1] & 0x0F) << 8) | data[2];
  *y = ((int16_t)(data[3] & 0x0F) << 8) | data[4];

  // 边界校验
  if (*x >= LCD_WIDTH || *y >= LCD_HEIGHT) return false;

  if (s_touch_cb) s_touch_cb(*x, *y, true);
  return true;
}

void touch_set_callback(void (*cb)(int16_t x, int16_t y, bool pressed)) {
  s_touch_cb = cb;
}

} // namespace hal