/*
 * ============================================================
 *  hal/tca9554.cpp — TCA9554 GPIO 扩展器实现
 *  用于控制 LCD RST, 背光, SD CS 等
 * ============================================================
 */
#include "hal/tca9554.h"
#include "pin_config.h"
#include <Wire.h>

namespace hal {

static bool s_tca9554_ok = false;

// TCA9554 寄存器
#define TCA9554_REG_INPUT   0x00
#define TCA9554_REG_OUTPUT  0x01
#define TCA9554_REG_INVERT  0x02
#define TCA9554_REG_CONFIG  0x03

static uint8_t s_output_state = 0x00;

static bool tca9554_write_reg(uint8_t reg, uint8_t data) {
  Wire.beginTransmission(TCA9554_ADDR);
  Wire.write(reg);
  Wire.write(data);
  return Wire.endTransmission() == 0;
}

static bool tca9554_read_reg(uint8_t reg, uint8_t* data) {
  Wire.beginTransmission(TCA9554_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  Wire.requestFrom(TCA9554_ADDR, (uint8_t)1);
  if (!Wire.available()) return false;
  *data = Wire.read();
  return true;
}

bool tca9554_init() {
  // I2C 已在 pmu_init() 中初始化, 这里不再重复调用 Wire.begin()
  delay(10);

  // 验证芯片存在
  uint8_t config = 0;
  if (!tca9554_read_reg(TCA9554_REG_CONFIG, &config)) {
    Serial.println(F("[tca9554] not found on I2C!"));
    s_tca9554_ok = false;
    return false;
  }

  // 配置输出引脚
  // EXIO0 (LCD BL), EXIO1 (LCD RST), EXIO7 (SD CS) 作为输出
  // 其他引脚作为输入
  uint8_t dir = 0xF8;  // bit0-2 输出, bit3-7 输入
  if (!tca9554_write_reg(TCA9554_REG_CONFIG, dir)) {
    Serial.println(F("[tca9554] config write failed!"));
    s_tca9554_ok = false;
    return false;
  }

  // 初始状态: LCD BL=HIGH, LCD RST=HIGH, SD CS=HIGH
  s_output_state = (1 << TCA9554_PIN_LCD_BL) |
                   (1 << TCA9554_PIN_LCD_RST) |
                   (1 << TCA9554_PIN_SD_CS);
  tca9554_write_reg(TCA9554_REG_OUTPUT, s_output_state);

  s_tca9554_ok = true;
  Serial.println(F("[tca9554] init OK"));
  return true;
}

void tca9554_write_pin(uint8_t pin, bool state) {
  if (!s_tca9554_ok || pin > 7) return;

  if (state) {
    s_output_state |= (1 << pin);
  } else {
    s_output_state &= ~(1 << pin);
  }
  tca9554_write_reg(TCA9554_REG_OUTPUT, s_output_state);
}

bool tca9554_read_pin(uint8_t pin) {
  if (!s_tca9554_ok || pin > 7) return false;

  uint8_t input = 0;
  if (tca9554_read_reg(TCA9554_REG_INPUT, &input)) {
    return (input >> pin) & 0x01;
  }
  return false;
}

void tca9554_lcd_reset() {
  if (!s_tca9554_ok) return;

  // 拉低 RST
  tca9554_write_pin(TCA9554_PIN_LCD_RST, false);
  delay(20);
  // 拉高 RST
  tca9554_write_pin(TCA9554_PIN_LCD_RST, true);
  delay(120);
}

} // namespace hal
