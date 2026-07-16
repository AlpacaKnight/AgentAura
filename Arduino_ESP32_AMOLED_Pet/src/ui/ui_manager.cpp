/*
 * ============================================================
 *  ui/ui_manager.cpp — LVGL 界面管理器实现
 * ============================================================
 */
#include "ui/ui_manager.h"
#include "comm/comm_manager.h"
#include "comm/wifi_manager.h"
#include "comm/ble_server.h"
#include "hal/display.h"
#include "hal/touch.h"
#include "pin_config.h"
#include "state.h"
#include <Arduino.h>
#include <lvgl.h>
#include <esp_timer.h>

namespace ui {

#define EXAMPLE_LVGL_TICK_PERIOD_MS 2

// 前向声明
static void _ui_init_pet_screen();
static void _ui_init_settings_screen();
static void _ui_init_apps_screen();

// LVGL 显示缓冲区
static lv_disp_draw_buf_t s_draw_buf;
static lv_color_t* s_buf1 = nullptr;
static lv_color_t* s_buf2 = nullptr;

// LVGL 驱动
static lv_disp_drv_t s_disp_drv;
static lv_indev_drv_t s_indev_drv;
static esp_timer_handle_t s_lvgl_tick_timer = nullptr;

// 全局 UI 对象 (主界面)
static lv_obj_t* s_screen_main = nullptr;
static lv_obj_t* s_pet_label = nullptr;
static lv_obj_t* s_msg_label = nullptr;
static lv_obj_t* s_hp_bar = nullptr;
static lv_obj_t* s_mp_bar = nullptr;
static lv_obj_t* s_approval_win = nullptr;
static lv_obj_t* s_battery_label = nullptr;
static lv_obj_t* s_countdown_label = nullptr;

// 设置页面
static lv_obj_t* s_screen_settings = nullptr;

// App 启动器页面
static lv_obj_t* s_screen_apps = nullptr;
static lv_obj_t* s_apps_wifi_label = nullptr;
static lv_obj_t* s_apps_ble_label = nullptr;

// 审批回调
static void (*s_approval_on_confirm)(void) = nullptr;
static void (*s_approval_on_reject)(void) = nullptr;

// 当前活动页面
enum class ActivePage : uint8_t {
  PET,
  SETTINGS,
  APPS
};
static ActivePage s_active_page = ActivePage::PET;

// ==================== 显示驱动刷新回调 ====================
static void disp_flush_cb(lv_disp_drv_t* disp, const lv_area_t* area, lv_color_t* color_p) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;

  hal::gfx->draw16bitRGBBitmap(area->x1, area->y1,
                                (uint16_t*)color_p, w, h);
  lv_disp_flush_ready(disp);
}

static void example_increase_lvgl_tick(void* arg) {
  (void)arg;
  lv_tick_inc(EXAMPLE_LVGL_TICK_PERIOD_MS);
}

// ==================== 触摸输入驱动 ====================
static void touch_read_cb(lv_indev_drv_t* drv, lv_indev_data_t* data) {
  (void)drv;
  int16_t x = 0, y = 0;

  if (!hal::touch_available()) {
    data->state = LV_INDEV_STATE_REL;
    return;
  }

  if (hal::touch_read(&x, &y)) {
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PR;
    touchActivity();
  } else {
    data->state = LV_INDEV_STATE_REL;
  }
}

// ==================== 初始化 LVGL 和硬件 ====================
void ui_init() {
  // 1. 初始化显示
  hal::display_init();

  // 2. 初始化触摸
  hal::touch_init();

  // 3. 初始化 LVGL
  lv_init();

  // 参考官方教程：使用 esp_timer 为 LVGL 提供稳定 tick
  if (s_lvgl_tick_timer == nullptr) {
    const esp_timer_create_args_t lvgl_tick_timer_args = {
      .callback = &example_increase_lvgl_tick,
      .arg = nullptr,
      .dispatch_method = ESP_TIMER_TASK,
      .name = "lvgl_tick"
    };
    esp_timer_create(&lvgl_tick_timer_args, &s_lvgl_tick_timer);
    esp_timer_start_periodic(s_lvgl_tick_timer, EXAMPLE_LVGL_TICK_PERIOD_MS * 1000);
  }

  // 4. 配置显示缓冲区 (使用 PSRAM)
  size_t buf_size = LCD_WIDTH * 40 * sizeof(lv_color_t);
  if (psramFound()) {
    s_buf1 = (lv_color_t*)ps_malloc(buf_size);
    s_buf2 = (lv_color_t*)ps_malloc(buf_size);
  } else {
    s_buf1 = (lv_color_t*)malloc(buf_size);
    s_buf2 = (lv_color_t*)malloc(buf_size);
  }

  lv_disp_draw_buf_init(&s_draw_buf, s_buf1, s_buf2, LCD_WIDTH * 40);

  // 5. 注册显示驱动
  lv_disp_drv_init(&s_disp_drv);
  s_disp_drv.hor_res = LCD_WIDTH;
  s_disp_drv.ver_res = LCD_HEIGHT;
  s_disp_drv.flush_cb = disp_flush_cb;
  s_disp_drv.draw_buf = &s_draw_buf;
  lv_disp_drv_register(&s_disp_drv);

  // 6. 注册触摸驱动
  lv_indev_drv_init(&s_indev_drv);
  s_indev_drv.type = LV_INDEV_TYPE_POINTER;
  s_indev_drv.read_cb = touch_read_cb;
  lv_indev_drv_register(&s_indev_drv);

  // 7. 创建主界面
  s_screen_main = lv_obj_create(NULL);
  lv_scr_load(s_screen_main);

  // 8. 初始化所有页面
  _ui_init_pet_screen();
  _ui_init_settings_screen();
  _ui_init_apps_screen();
}

// ==================== 创建桌宠主界面 ====================
static void _ui_init_pet_screen() {
  // 背景色 (深色主题)
  lv_obj_set_style_bg_color(s_screen_main, lv_color_hex(0x1a1a2e), 0);

  // 宠物表情标签 (居中, 大号)
  s_pet_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_pet_label, &lv_font_montserrat_48, 0);
  lv_obj_set_style_text_color(s_pet_label, lv_color_hex(0xFFFFFF), 0);
  lv_label_set_text(s_pet_label, "AURA");  // 默认占位文本，确保 ASCII 字体可见
  lv_obj_center(s_pet_label);

  // 消息气泡 (宠物的说话内容)
  s_msg_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_msg_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(s_msg_label, lv_color_hex(0x94A3B8), 0);
  lv_obj_align(s_msg_label, LV_ALIGN_TOP_MID, 0, 15);
  lv_label_set_text(s_msg_label, "");

  // 电池信息 (右下角)
  s_battery_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_battery_label, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(s_battery_label, lv_color_hex(0x22C55E), 0);
  lv_obj_align(s_battery_label, LV_ALIGN_BOTTOM_RIGHT, -5, -5);
  lv_label_set_text(s_battery_label, "BAT 100%");

  // 倒计时标签 (5小时额度耗尽时显示)
  s_countdown_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_countdown_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(s_countdown_label, lv_color_hex(0xEF4444), 0);
  lv_obj_align(s_countdown_label, LV_ALIGN_TOP_MID, 0, 80);
  lv_label_set_text(s_countdown_label, "");
  lv_obj_add_flag(s_countdown_label, LV_OBJ_FLAG_HIDDEN);

  // HP 条 (总额度) - 仅连接Claude/Codex时显示
  s_hp_bar = lv_bar_create(s_screen_main);
  lv_obj_set_size(s_hp_bar, 200, 12);
  lv_obj_align(s_hp_bar, LV_ALIGN_BOTTOM_MID, 0, -30);
  lv_bar_set_range(s_hp_bar, 0, 100);
  lv_bar_set_value(s_hp_bar, 100, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(s_hp_bar, lv_color_hex(0x333344), 0);
  lv_obj_set_style_bg_color(s_hp_bar, lv_color_hex(0x22C55E), LV_PART_INDICATOR);
  lv_obj_add_flag(s_hp_bar, LV_OBJ_FLAG_HIDDEN);

  // MP 条 (5小时额度) - 仅连接Claude/Codex时显示
  s_mp_bar = lv_bar_create(s_screen_main);
  lv_obj_set_size(s_mp_bar, 200, 12);
  lv_obj_align(s_mp_bar, LV_ALIGN_BOTTOM_MID, 0, -46);
  lv_bar_set_range(s_mp_bar, 0, 100);
  lv_bar_set_value(s_mp_bar, 100, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(s_mp_bar, lv_color_hex(0x333344), 0);
  lv_obj_set_style_bg_color(s_mp_bar, lv_color_hex(0x3B82F6), LV_PART_INDICATOR);
  lv_obj_add_flag(s_mp_bar, LV_OBJ_FLAG_HIDDEN);
}

// ==================== UI 循环 ====================
void ui_loop() {
  lv_timer_handler();

  // 更新 UI 数据 (简单状态同步，后续可优化)
  static uint32_t s_last_update = 0;
  uint32_t now = millis();

  if (now - s_last_update > 500) {  // 每500ms更新一次
    s_last_update = now;

    // 更新电池
    char batt[16];
    snprintf(batt, sizeof(batt), "%s %d%%",
             state.battery_charging ? "CHG" : "BAT",
             state.battery_percent);
    lv_label_set_text(s_battery_label, batt);

    // 更新宠物表情
    switch (state.pet_state) {
      case PetState::IDLE:     lv_label_set_text(s_pet_label, "IDLE"); break;
      case PetState::RUNNING:  lv_label_set_text(s_pet_label, "RUN "); break;
      case PetState::THINKING: lv_label_set_text(s_pet_label, "THNK"); break;
      case PetState::SPEAKING: lv_label_set_text(s_pet_label, "TALK"); break;
      case PetState::ERROR:    lv_label_set_text(s_pet_label, "ERR!"); break;
      case PetState::SLEEP:    lv_label_set_text(s_pet_label, "SLP "); break;
      case PetState::OFFLINE:  lv_label_set_text(s_pet_label, "OFF "); break;
      default:                 lv_label_set_text(s_pet_label, "AURA"); break;
    }

    // 更新消息气泡
    if (state.msg_timestamp > 0 && now - state.msg_timestamp < 10000) {
      lv_label_set_text(s_msg_label, state.pet_message.c_str());
    } else {
      lv_label_set_text(s_msg_label, "");
    }

    // Agent 类型 - 血条/蓝条显示逻辑
    if (state.agent_type == AgentType::CLAUDE || state.agent_type == AgentType::CODEX) {
      lv_obj_clear_flag(s_hp_bar, LV_OBJ_FLAG_HIDDEN);
      lv_obj_clear_flag(s_mp_bar, LV_OBJ_FLAG_HIDDEN);

      // HP: 总额度百分比
      float hp_pct = (state.quota.total_quota > 0)
        ? ((state.quota.total_quota - state.quota.used_quota) / state.quota.total_quota * 100)
        : 100;
      lv_bar_set_value(s_hp_bar, (int16_t)constrain(hp_pct, 0, 100), LV_ANIM_OFF);

      // HP 颜色渐变
      if (hp_pct > 50) lv_obj_set_style_bg_color(s_hp_bar, lv_color_hex(0x22C55E), LV_PART_INDICATOR);  // 绿
      else if (hp_pct > 20) lv_obj_set_style_bg_color(s_hp_bar, lv_color_hex(0xEAB308), LV_PART_INDICATOR);  // 黄
      else lv_obj_set_style_bg_color(s_hp_bar, lv_color_hex(0xEF4444), LV_PART_INDICATOR);  // 红

      // MP: 5小时额度百分比
      float mp_pct = (state.quota.h5_total > 0)
        ? (state.quota.h5_remaining / state.quota.h5_total * 100)
        : 0;
      lv_bar_set_value(s_mp_bar, (int16_t)constrain(mp_pct, 0, 100), LV_ANIM_OFF);

      if (mp_pct > 30) lv_obj_set_style_bg_color(s_mp_bar, lv_color_hex(0x3B82F6), LV_PART_INDICATOR);  // 蓝
      else lv_obj_set_style_bg_color(s_mp_bar, lv_color_hex(0xF97316), LV_PART_INDICATOR);  // 橙

      // 黑白模式: 5小时额度耗尽
      if (isH5Depleted()) {
        lv_obj_set_style_img_recolor_opa(s_pet_label, LV_OPA_COVER, 0);
        lv_obj_set_style_img_recolor(s_pet_label, lv_color_hex(0x808080), 0);
        if (state.quota.refresh_sec > 0) {
          lv_obj_clear_flag(s_countdown_label, LV_OBJ_FLAG_HIDDEN);
          char cd[16];
          int h = state.quota.refresh_sec / 3600;
          int m = (state.quota.refresh_sec % 3600) / 60;
          int s = state.quota.refresh_sec % 60;
          snprintf(cd, sizeof(cd), "RFR %02d:%02d:%02d", h, m, s);
          lv_label_set_text(s_countdown_label, cd);
        }
      } else {
        lv_obj_set_style_img_recolor_opa(s_pet_label, LV_OPA_TRANSP, 0);
        lv_obj_add_flag(s_countdown_label, LV_OBJ_FLAG_HIDDEN);
      }
    } else {
      lv_obj_add_flag(s_hp_bar, LV_OBJ_FLAG_HIDDEN);
      lv_obj_add_flag(s_mp_bar, LV_OBJ_FLAG_HIDDEN);
      lv_obj_add_flag(s_countdown_label, LV_OBJ_FLAG_HIDDEN);
    }

    // 审批弹窗超时管理
    if (state.approval.active && state.approval.start_ms > 0) {
      if ((now - state.approval.start_ms) / 1000 > state.approval.timeout_s) {
        clearApproval();
        ui_hide_approval();
      }
    }

    // Apps 页面: 刷新 WiFi/蓝牙开关标签
    if (s_active_page == ActivePage::APPS) {
      if (s_apps_wifi_label) {
        lv_label_set_text(s_apps_wifi_label,
          state.wifi_enabled == RadioState::ON ? "WiFi: ON" : "WiFi: OFF");
      }
      if (s_apps_ble_label) {
        lv_label_set_text(s_apps_ble_label,
          state.ble_enabled == RadioState::ON ? "BLE: ON" : "BLE: OFF");
      }
    }
  }
}

// ==================== 创建设置页面 ====================
static void _ui_init_settings_screen() {
  s_screen_settings = lv_obj_create(NULL);

  // 背景色
  lv_obj_set_style_bg_color(s_screen_settings, lv_color_hex(0x1a1a2e), 0);

  // 标题
  lv_obj_t* title = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(title, lv_color_hex(0x0EA5E9), 0);
  lv_label_set_text(title, "Settings");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 15);

  // 亮度滑块
  lv_obj_t* brt_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(brt_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(brt_label, lv_color_hex(0x94A3B8), 0);
  lv_label_set_text(brt_label, "亮度");
  lv_obj_align(brt_label, LV_ALIGN_TOP_LEFT, 20, 55);

  lv_obj_t* brt_slider = lv_slider_create(s_screen_settings);
  lv_obj_set_size(brt_slider, 200, 16);
  lv_obj_align(brt_slider, LV_ALIGN_TOP_LEFT, 80, 52);
  lv_slider_set_range(brt_slider, 0, 255);
  lv_slider_set_value(brt_slider, state.brightness, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(brt_slider, lv_color_hex(0x333344), LV_PART_MAIN);
  lv_obj_set_style_bg_color(brt_slider, lv_color_hex(0x0EA5E9), LV_PART_INDICATOR);

  // 音量滑块
  lv_obj_t* vol_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(vol_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(vol_label, lv_color_hex(0x94A3B8), 0);
  lv_label_set_text(vol_label, "音量");
  lv_obj_align(vol_label, LV_ALIGN_TOP_LEFT, 20, 90);

  lv_obj_t* vol_slider = lv_slider_create(s_screen_settings);
  lv_obj_set_size(vol_slider, 200, 16);
  lv_obj_align(vol_slider, LV_ALIGN_TOP_LEFT, 80, 87);
  lv_slider_set_range(vol_slider, 0, 100);
  lv_slider_set_value(vol_slider, state.volume, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(vol_slider, lv_color_hex(0x333344), LV_PART_MAIN);
  lv_obj_set_style_bg_color(vol_slider, lv_color_hex(0x22C55E), LV_PART_INDICATOR);

  // 设备信息
  lv_obj_t* info_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(info_label, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(info_label, lv_color_hex(0x64748B), 0);
  lv_label_set_text(info_label, "");
  lv_obj_align(info_label, LV_ALIGN_TOP_LEFT, 20, 130);

  // 返回按钮 (触摸区域, 右下角)
  lv_obj_t* back_btn = lv_btn_create(s_screen_settings);
  lv_obj_set_size(back_btn, 80, 36);
  lv_obj_align(back_btn, LV_ALIGN_BOTTOM_RIGHT, -20, -20);
  lv_obj_set_style_bg_color(back_btn, lv_color_hex(0x0EA5E9), 0);
  lv_obj_t* back_lbl = lv_label_create(back_btn);
  lv_label_set_text(back_lbl, "Back");
  lv_obj_center(back_lbl);
  lv_obj_set_style_text_color(back_lbl, lv_color_hex(0xFFFFFF), 0);
  lv_obj_add_event_cb(back_btn, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    ui_show_pet();
  }, LV_EVENT_CLICKED, NULL);
}

// ==================== 创建 App 启动器页面 ====================
static void _ui_init_apps_screen() {
  s_screen_apps = lv_obj_create(NULL);

  // 背景色
  lv_obj_set_style_bg_color(s_screen_apps, lv_color_hex(0x1a1a2e), 0);

  // 标题
  lv_obj_t* title = lv_label_create(s_screen_apps);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(title, lv_color_hex(0x0EA5E9), 0);
  lv_label_set_text(title, "Apps");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 15);

  // 滚动列表
  lv_obj_t* list = lv_list_create(s_screen_apps);
  lv_obj_set_size(list, LCD_WIDTH - 40, LCD_HEIGHT - 130);
  lv_obj_align(list, LV_ALIGN_TOP_MID, 0, 50);
  lv_obj_set_style_bg_color(list, lv_color_hex(0x1a1a2e), 0);
  lv_obj_set_style_border_width(list, 0, 0);
  lv_obj_set_style_pad_row(list, 4, 0);

  // 导航: 设置
  lv_obj_t* btn_settings = lv_list_add_btn(list, nullptr, "Settings");
  lv_obj_set_style_bg_color(btn_settings, lv_color_hex(0x2a2a3e), 0);
  lv_obj_set_style_text_color(btn_settings, lv_color_hex(0xcbd5e1), 0);
  lv_obj_add_event_cb(btn_settings, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    ui_show_settings();
  }, LV_EVENT_CLICKED, NULL);

  // 导航: 桌宠主页
  lv_obj_t* btn_pet = lv_list_add_btn(list, nullptr, "Pet");
  lv_obj_set_style_bg_color(btn_pet, lv_color_hex(0x2a2a3e), 0);
  lv_obj_set_style_text_color(btn_pet, lv_color_hex(0xcbd5e1), 0);
  lv_obj_add_event_cb(btn_pet, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    ui_show_pet();
  }, LV_EVENT_CLICKED, NULL);

  // 快捷开关: WiFi
  lv_obj_t* btn_wifi = lv_list_add_btn(list, nullptr, "");
  s_apps_wifi_label = lv_label_create(btn_wifi);
  lv_obj_set_style_text_font(s_apps_wifi_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(s_apps_wifi_label, lv_color_hex(0xcbd5e1), 0);
  lv_obj_center(s_apps_wifi_label);
  lv_obj_set_style_bg_color(btn_wifi, lv_color_hex(0x2a2a3e), 0);
  lv_obj_add_event_cb(btn_wifi, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    comm::wifi_toggle(state.wifi_enabled != RadioState::ON);
  }, LV_EVENT_CLICKED, NULL);

  // 快捷开关: 蓝牙
  lv_obj_t* btn_ble = lv_list_add_btn(list, nullptr, "");
  s_apps_ble_label = lv_label_create(btn_ble);
  lv_obj_set_style_text_font(s_apps_ble_label, &lv_font_montserrat_14, 0);
  lv_obj_set_style_text_color(s_apps_ble_label, lv_color_hex(0xcbd5e1), 0);
  lv_obj_center(s_apps_ble_label);
  lv_obj_set_style_bg_color(btn_ble, lv_color_hex(0x2a2a3e), 0);
  lv_obj_add_event_cb(btn_ble, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    comm::ble_toggle(state.ble_enabled != RadioState::ON);
  }, LV_EVENT_CLICKED, NULL);

  // 返回按钮
  lv_obj_t* back_btn = lv_btn_create(s_screen_apps);
  lv_obj_set_size(back_btn, 80, 36);
  lv_obj_align(back_btn, LV_ALIGN_BOTTOM_RIGHT, -20, -20);
  lv_obj_set_style_bg_color(back_btn, lv_color_hex(0x0EA5E9), 0);
  lv_obj_t* back_lbl = lv_label_create(back_btn);
  lv_label_set_text(back_lbl, "Back");
  lv_obj_center(back_lbl);
  lv_obj_set_style_text_color(back_lbl, lv_color_hex(0xFFFFFF), 0);
  lv_obj_add_event_cb(back_btn, [](lv_event_t* e) {
    (void)e;
    touchActivity();
    ui_show_pet();
  }, LV_EVENT_CLICKED, NULL);
}

// ==================== 页面切换 ====================
void ui_refresh_now() {
  lv_obj_t* active = lv_scr_act();
  if (!active) return;
  lv_obj_invalidate(active);
  lv_refr_now(NULL);
}

void ui_show_pet() {
  ui_hide_approval();
  if (s_screen_main) {
    lv_scr_load(s_screen_main);
    s_active_page = ActivePage::PET;
  }
}

void ui_show_settings() {
  s_active_page = ActivePage::SETTINGS;
  if (s_screen_settings) {
    lv_scr_load(s_screen_settings);
  }
}

void ui_show_apps() {
  s_active_page = ActivePage::APPS;
  if (s_screen_apps) {
    lv_scr_load(s_screen_apps);
  }
}

void ui_show_approval(const char* title, const char* desc,
                       const char* confirm_text, const char* reject_text,
                       void (*on_confirm)(void), void (*on_reject)(void)) {
  if (s_approval_win) lv_obj_del(s_approval_win);

  // 存储回调
  s_approval_on_confirm = on_confirm;
  s_approval_on_reject = on_reject;

  s_approval_win = lv_win_create(lv_scr_act(), 40);
  lv_obj_set_size(s_approval_win, LCD_WIDTH - 40, 220);
  lv_obj_center(s_approval_win);
  lv_win_add_title(s_approval_win, title);

  // 描述
  lv_obj_t* desc_label = lv_label_create(lv_win_get_content(s_approval_win));
  lv_label_set_text(desc_label, desc);
  lv_obj_set_style_text_font(desc_label, &lv_font_montserrat_14, 0);
  lv_obj_align(desc_label, LV_ALIGN_TOP_LEFT, 10, 10);

  // 确认按钮
  lv_obj_t* confirm_btn = lv_btn_create(lv_win_get_content(s_approval_win));
  lv_obj_align(confirm_btn, LV_ALIGN_BOTTOM_LEFT, 10, -10);
  lv_obj_set_style_bg_color(confirm_btn, lv_color_hex(0x22C55E), 0);
  lv_obj_t* confirm_lbl = lv_label_create(confirm_btn);
  lv_label_set_text(confirm_lbl, confirm_text);
  lv_obj_center(confirm_lbl);
  lv_obj_set_style_text_color(confirm_lbl, lv_color_hex(0xFFFFFF), 0);

  // 批准按钮事件
  lv_obj_add_event_cb(confirm_btn, [](lv_event_t* e) {
    if (s_approval_on_confirm) s_approval_on_confirm();
    ui_hide_approval();
  }, LV_EVENT_CLICKED, NULL);

  // 拒绝按钮
  lv_obj_t* reject_btn = lv_btn_create(lv_win_get_content(s_approval_win));
  lv_obj_align(reject_btn, LV_ALIGN_BOTTOM_RIGHT, -10, -10);
  lv_obj_set_style_bg_color(reject_btn, lv_color_hex(0xEF4444), 0);
  lv_obj_t* reject_lbl = lv_label_create(reject_btn);
  lv_label_set_text(reject_lbl, reject_text);
  lv_obj_center(reject_lbl);
  lv_obj_set_style_text_color(reject_lbl, lv_color_hex(0xFFFFFF), 0);

  // 拒绝按钮事件
  lv_obj_add_event_cb(reject_btn, [](lv_event_t* e) {
    if (s_approval_on_reject) s_approval_on_reject();
    ui_hide_approval();
  }, LV_EVENT_CLICKED, NULL);
}

void ui_hide_approval() {
  if (s_approval_win) {
    lv_obj_del(s_approval_win);
    s_approval_win = nullptr;
  }
  s_approval_on_confirm = nullptr;
  s_approval_on_reject = nullptr;
}

lv_disp_drv_t* ui_get_disp_drv() {
  return &s_disp_drv;
}

} // namespace ui