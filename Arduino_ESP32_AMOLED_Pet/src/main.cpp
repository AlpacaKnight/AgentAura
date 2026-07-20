/*
 * ============================================================
 *  AgentAura — Codex Desktop Pet 主程序
 *  目标硬件: Waveshare ESP32-C6-Touch-AMOLED-1.8
 *             (SH8601 QSPI AMOLED + FT3168 Touch)
 *
 *  连接方式: USB 串口 / WiFi HTTP/WebSocket/UDP / BLE
 *  功能: 桌面动画, 血条/蓝条(额度), 审批系统, 设置中心
 *
 *  参考:
 *    - 环形灯固件: Arduino_ESP32_RingLight
 *    - Waveshare 官方示例: ESP32-C6-Touch-AMOLED-1.8 Demo
 * ============================================================
 */
#include <Arduino.h>
#include "config.h"
#include "state.h"
#include "storage.h"
#include "command.h"
#include "hal/display.h"
#include "hal/touch.h"
#include "hal/pmu.h"
#include "hal/audio.h"
#include "hal/buttons.h"
#include "hal/tca9554.h"
#include "comm/comm_manager.h"
#include "ui/ui_manager.h"

// ==================== 定时器 ====================
static uint32_t s_last_pmu_check = 0;
static uint32_t s_last_quota_tick = 0;
static uint32_t s_last_screen_check = 0;

// ==================== 打印启动 Banner ====================
static void print_banner() {
  Serial.println();
  Serial.println(F("========================================"));
  Serial.print(F("  ")); Serial.print(FW_NAME);
  Serial.print(F(" v")); Serial.println(FW_VERSION);
  Serial.print(F("  ")); Serial.println(DEVICE_MODEL);
  Serial.print(F("  Screen: ")); Serial.print(LCD_WIDTH);
  Serial.print(F("x")); Serial.println(LCD_HEIGHT);
  Serial.println(F("========================================"));
}

// ==================== 开机启动动画 ====================
static void startup_animation() {
  if (!hal::gfx) return;
  hal::gfx->fillScreen(RGB565_BLACK);

  // 启动亮度渐变
  for (int i = 0; i <= 255; i += 5) {
    hal::display_set_brightness(i);
    delay(10);
  }

  hal::gfx->setCursor(LCD_WIDTH / 2 - 60, LCD_HEIGHT / 2 - 24);
  hal::gfx->setTextColor(RGB565_WHITE);
  hal::gfx->setTextSize(2);
  hal::gfx->println(F("AgentAura"));
  hal::gfx->setCursor(LCD_WIDTH / 2 - 40, LCD_HEIGHT / 2 + 10);
  hal::gfx->println(F("v" FW_VERSION));

  delay(1500);
  hal::gfx->fillScreen(RGB565_BLACK);
}

// ==================== 物理按键事件处理 ====================
static void on_boot_short() {
  Serial.println(F("[event] BOOT short press - toggle waving"));
  if (state.pet_state == PetState::WAVING) {
    setPetState(PetState::IDLE);
  } else {
    setPetState(PetState::WAVING);
  }
}

static void on_boot_long() {
  Serial.println(F("[event] BOOT long press -> Apps"));
  touchActivity();
  ui::ui_show_apps();
}

static void on_pwr_short() {
  Serial.println(F("[event] PWR short press - cancel/reject"));
  if (state.approval.active) {
    String response = "{\"type\":\"approval_response\",\"id\":\"" +
      state.approval.id + "\",\"result\":\"rejected\"}";
    comm::comm_broadcast(response);
    clearApproval();
    ui::ui_hide_approval();
    Serial.printf("[event] approval rejected: %s\n", state.approval.id.c_str());
  }
}

// ==================== 额度倒计时 Tick ====================
static void quota_tick() {
  if (isH5Depleted() && state.quota.refresh_sec > 0) {
    state.quota.refresh_sec--;
  }
}

// ==================== PMU 数据轮询 ====================
static void poll_pmu() {
  state.battery_percent  = hal::pmu_get_battery_level();
  state.battery_charging = hal::pmu_get_charging();
  state.battery_voltage  = hal::pmu_get_battery_voltage();
}

// ==================== 屏幕省电管理 ====================
static void manage_screen() {
#if SCREEN_ALWAYS_ON
  if (!state.screen_on) {
    setScreenOn(true);
    hal::display_on();
  }
  if (state.screen_dim) {
    setScreenDim(false);
  }
  hal::display_set_brightness(state.brightness);
#else
  uint32_t now = millis();
  uint32_t idle = now - state.last_activity;

  if (idle > SCREEN_OFF_TIMEOUT && state.screen_on) {
    setScreenOn(false);
    hal::display_off();
    Serial.println(F("[screen] off (idle timeout)"));
  } else if (idle > SCREEN_DIM_TIMEOUT && !state.screen_dim && state.screen_on) {
    setScreenDim(true);
    hal::display_set_brightness(state.brightness / 4);
    Serial.println(F("[screen] dimmed"));
  } else if (idle < SCREEN_DIM_TIMEOUT && state.screen_dim) {
    setScreenDim(false);
    hal::display_set_brightness(state.brightness);
  }
#endif
}

// ==================== setup ====================
void setup() {
  // 1. 串口
  Serial.begin(115200);
  // After an upload-triggered reset the host can leave USB Serial/JTAG
  // connected without consuming output. Never let startup logs block the
  // Arduino task; dropping a log line is preferable to freezing UI/touch.
  Serial.setTxTimeoutMs(0);
  delay(150);
  print_banner();

  // 2. NVS 存储
  storage::begin();
  state.brightness = storage::loadBrightness(DEFAULT_BRIGHTNESS);
  state.volume     = storage::loadVolume(DEFAULT_VOLUME);
  state.ble_enabled = storage::loadBleEnabled(BLE_ENABLED)
                        ? RadioState::ON : RadioState::OFF;
  Serial.printf("[main] brt=%d vol=%d ble=%s\n",
                state.brightness, state.volume,
                state.ble_enabled == RadioState::ON ? "on" : "off");

  // 3. 电源管理 (必须在显示之前初始化, AMOLED 需要 AXP2101 供电)
  hal::pmu_init();
  poll_pmu();
  Serial.printf("[main] battery: %d%% %s %.2fV\n",
    state.battery_percent,
    state.battery_charging ? "CHG" : " ",
    state.battery_voltage);

  // 4. TCA9554 GPIO 扩展器 (LCD RST, 背光控制)
  hal::tca9554_init();

  // 5. LVGL UI (内部初始化显示 + 触摸)
  ui::ui_init();
  ui::ui_show_pet();
  Serial.println(F("[main] UI + display init done"));

  // 6. 音频
  hal::audio_init();

  // 7. 物理按键
  hal::buttons_init();
  hal::on_boot_short_press(on_boot_short);
  hal::on_boot_long_press(on_boot_long);
  hal::on_pwr_short_press(on_pwr_short);

  // 8. 通信层(WiFi/USB/BLE)
  comm::comm_begin();

  // WiFi/BLE first reserve their internal RAM, then load the optional frame.
  ui::ui_load_pet_assets();

  touchActivity();
  Serial.println(F("[main] setup done. type 'help' for commands."));
}

// ==================== loop ====================
void loop() {
  uint32_t now = millis();

  // 通信轮询
  comm::comm_loop();

  // 按键轮询
  hal::buttons_loop();

  // UI 轮询
  ui::ui_loop();

  // PMU 数据读取 (每5秒)
  if (now - s_last_pmu_check > 5000) {
    s_last_pmu_check = now;
    poll_pmu();
  }

  // 额度倒计时 (每秒)
  if (now - s_last_quota_tick > 1000) {
    s_last_quota_tick = now;
    quota_tick();
  }

  // 屏幕管理 (每秒)
  if (now - s_last_screen_check > 1000) {
    s_last_screen_check = now;
    manage_screen();
  }
}
