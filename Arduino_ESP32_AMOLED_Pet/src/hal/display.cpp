/*
 * ============================================================
 *  hal/display.cpp — AMOLED 显示屏实现
 *  自动检测 V1 (SH8601) 和 V2 (CO5300)
 * ============================================================
 */
#include "hal/display.h"
#include "hal/tca9554.h"
#include "pin_config.h"
#include <Arduino.h>
#include <SPI.h>

namespace hal {

Arduino_GFX* gfx = nullptr;

void display_init() {
  Serial.println(F("[display] initializing..."));

  // 如果使用 TCA9554 控制 RST, 先执行复位脉冲
  if (LCD_RST == -1) {
    Serial.println(F("[display] using TCA9554 for LCD reset"));
    tca9554_lcd_reset();
  }

  // QSPI 总线
  Arduino_DataBus* bus = new Arduino_ESP32QSPI(
    LCD_CS, LCD_SCLK, LCD_SDIO0, LCD_SDIO1, LCD_SDIO2, LCD_SDIO3);

  if (!bus) {
    Serial.println(F("[display] QSPI bus creation FAILED!"));
    return;
  }

#if defined(LCD_DRIVER_SH8601)
  Serial.println(F("[display] using SH8601 driver"));
  gfx = new Arduino_SH8601(bus, LCD_RST, 0, LCD_WIDTH, LCD_HEIGHT);
#elif defined(LCD_DRIVER_CO5300)
  Serial.println(F("[display] using CO5300 driver"));
  gfx = new Arduino_CO5300(bus, LCD_RST, 0, LCD_WIDTH, LCD_HEIGHT);
#else
  // 默认 V1
  Serial.println(F("[display] using default SH8601 driver"));
  gfx = new Arduino_SH8601(bus, LCD_RST, 0, LCD_WIDTH, LCD_HEIGHT);
#endif

  if (!gfx) {
    Serial.println(F("[display] driver creation FAILED!"));
    return;
  }

  if (!gfx->begin()) {
    Serial.println(F("[display] gfx->begin() FAILED!"));
    return;
  }

  gfx->fillScreen(RGB565_BLACK);

  // 设置初始亮度
#if defined(LCD_DRIVER_SH8601) || !defined(LCD_DRIVER_CO5300)
  // SH8601 有 setBrightness 方法
  static_cast<Arduino_SH8601*>(gfx)->setBrightness(DEFAULT_BRIGHTNESS);
#endif

  Serial.print(F("[display] init OK ("));
  Serial.print(gfx->width());
  Serial.print(F("x"));
  Serial.print(gfx->height());
  Serial.println(F(")"));
}

void display_set_brightness(uint8_t level) {
  if (!gfx) return;

#if defined(LCD_DRIVER_SH8601) || !defined(LCD_DRIVER_CO5300)
  // SH8601 有 setBrightness 方法
  static_cast<Arduino_SH8601*>(gfx)->setBrightness(level);
#endif
}

void display_on() {
  if (gfx) {
    gfx->displayOn();
  }
}

void display_off() {
  if (gfx) {
    gfx->displayOff();
  }
}

void display_set_rotation(uint8_t r) {
  if (gfx) {
    gfx->setRotation(r);
  }
}

} // namespace hal
