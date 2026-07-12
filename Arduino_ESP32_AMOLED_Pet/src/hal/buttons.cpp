/*
 * ============================================================
 *  hal/buttons.cpp — 物理按键实现
 * ============================================================
 */
#include "hal/buttons.h"
#include "pin_config.h"
#include "config.h"

namespace hal {

#define BOOT_PIN       BOOT_BUTTON_GPIO  // GPIO0

static ButtonCallback s_boot_short_cb = nullptr;
static ButtonCallback s_boot_long_cb  = nullptr;
static ButtonCallback s_pwr_short_cb  = nullptr;

static bool s_boot_last_state = HIGH;
static uint32_t s_boot_press_ms = 0;
static bool s_boot_long_reported = false;

void buttons_init() {
  pinMode(BOOT_PIN, INPUT_PULLUP);
  s_boot_last_state = digitalRead(BOOT_PIN);
  Serial.println(F("[buttons] init OK"));
}

void on_boot_short_press(ButtonCallback cb) {
  s_boot_short_cb = cb;
}

void on_boot_long_press(ButtonCallback cb) {
  s_boot_long_cb = cb;
}

void on_pwr_short_press(ButtonCallback cb) {
  s_pwr_short_cb = cb;
}

void buttons_loop() {
  uint32_t now = millis();
  bool boot_state = digitalRead(BOOT_PIN);

  // ---- BOOT 按键 ----
  if (boot_state == LOW && s_boot_last_state == HIGH) {
    // 按下
    s_boot_press_ms = now;
    s_boot_long_reported = false;
  } else if (boot_state == LOW && s_boot_last_state == LOW) {
    // 持续按下 - 检查长按
    if (!s_boot_long_reported && (now - s_boot_press_ms >= BOOT_LONG_PRESS_MS)) {
      s_boot_long_reported = true;
      if (s_boot_long_cb) s_boot_long_cb();
    }
  } else if (boot_state == HIGH && s_boot_last_state == LOW) {
    // 释放 - 如果是短按
    if (!s_boot_long_reported && (now - s_boot_press_ms >= BOOT_DEBOUNCE_MS)) {
      if (s_boot_short_cb) s_boot_short_cb();
    }
  }

  s_boot_last_state = boot_state;
}

} // namespace hal