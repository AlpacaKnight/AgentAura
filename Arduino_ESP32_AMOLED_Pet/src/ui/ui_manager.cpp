/*
 * ============================================================
 *  ui/ui_manager.cpp — LVGL 界面管理器实现
 * ============================================================
 */
#include "ui/ui_manager.h"
#include "comm/comm_manager.h"
#include "comm/wifi_manager.h"
#include "comm/ble_server.h"
#include "hal/audio.h"
#include "hal/display.h"
#include "hal/touch.h"
#include "pin_config.h"
#include "state.h"
#include "storage.h"
#include "ui/tiquan_v2_frames.h"
#include "ui/tiquan_v2_idle.h"
#include <Arduino.h>
#include <SPIFFS.h>
#include <lvgl.h>
#include <esp_heap_caps.h>

LV_FONT_DECLARE(lv_font_agentaura_16);

namespace ui {

// 前向声明
static void _ui_init_pet_screen();
static void _ui_init_settings_screen();
static void _ui_init_apps_screen();
static bool s_slider_interacting = false;
static lv_obj_t* s_brightness_slider = nullptr;
static lv_obj_t* s_brightness_value_label = nullptr;
static lv_obj_t* s_volume_slider = nullptr;
static lv_obj_t* s_volume_value_label = nullptr;

static void _sync_settings_controls() {
  if (s_slider_interacting) return;

  if (s_brightness_slider &&
      lv_slider_get_value(s_brightness_slider) != state.brightness) {
    lv_slider_set_value(s_brightness_slider, state.brightness, LV_ANIM_OFF);
  }
  if (s_brightness_value_label) {
    lv_label_set_text_fmt(s_brightness_value_label, "%u", state.brightness);
  }

  if (s_volume_slider &&
      lv_slider_get_value(s_volume_slider) != state.volume) {
    lv_slider_set_value(s_volume_slider, state.volume, LV_ANIM_OFF);
  }
  if (s_volume_value_label) {
    lv_label_set_text_fmt(s_volume_value_label, "%u", state.volume);
  }
}

static void _brightness_slider_event_cb(lv_event_t* event) {
  lv_event_code_t code = lv_event_get_code(event);
  lv_obj_t* slider = lv_event_get_target(event);
  lv_obj_t* value_label = static_cast<lv_obj_t*>(lv_event_get_user_data(event));
  uint8_t value = static_cast<uint8_t>(lv_slider_get_value(slider));

  if (code == LV_EVENT_PRESSED) {
    s_slider_interacting = true;
  } else if (code == LV_EVENT_VALUE_CHANGED) {
    if (value_label) lv_label_set_text_fmt(value_label, "%u", value);
    setBrightness(value);
    hal::display_set_brightness(value);
    touchActivity();
  } else if (code == LV_EVENT_RELEASED) {
    s_slider_interacting = false;
    storage::saveBrightness(value);
    Serial.printf("[ui] brightness -> %u\n", value);
  } else if (code == LV_EVENT_PRESS_LOST) {
    s_slider_interacting = false;
  }
}

static void _volume_slider_event_cb(lv_event_t* event) {
  lv_event_code_t code = lv_event_get_code(event);
  lv_obj_t* slider = lv_event_get_target(event);
  lv_obj_t* value_label = static_cast<lv_obj_t*>(lv_event_get_user_data(event));
  uint8_t value = static_cast<uint8_t>(lv_slider_get_value(slider));

  if (code == LV_EVENT_PRESSED) {
    s_slider_interacting = true;
  } else if (code == LV_EVENT_VALUE_CHANGED) {
    if (value_label) lv_label_set_text_fmt(value_label, "%u", value);
    setVolume(value);
    hal::audio_set_volume(value);
    touchActivity();
  } else if (code == LV_EVENT_RELEASED) {
    s_slider_interacting = false;
    storage::saveVolume(value);
    hal::audio_play_tone();
    Serial.printf("[ui] volume -> %u\n", value);
  } else if (code == LV_EVENT_PRESS_LOST) {
    s_slider_interacting = false;
  }
}

// LVGL 显示缓冲区
static lv_disp_draw_buf_t s_draw_buf;
static lv_color_t* s_buf1 = nullptr;

// LVGL 驱动
static lv_disp_drv_t s_disp_drv;
static lv_indev_drv_t s_indev_drv;

// 全局 UI 对象 (主界面)
static lv_obj_t* s_screen_main = nullptr;
static lv_obj_t* s_pet_image = nullptr;
static lv_obj_t* s_pet_face = nullptr;
static lv_obj_t* s_pet_eye_left = nullptr;
static lv_obj_t* s_pet_eye_right = nullptr;
static lv_obj_t* s_home_status_label = nullptr;
static lv_obj_t* s_home_hint_label = nullptr;
static lv_obj_t* s_pet_label = nullptr;
static lv_obj_t* s_msg_label = nullptr;
static lv_obj_t* s_hp_bar = nullptr;
static lv_obj_t* s_mp_bar = nullptr;
static lv_obj_t* s_approval_win = nullptr;
static lv_obj_t* s_battery_label = nullptr;
static lv_obj_t* s_countdown_label = nullptr;

// 设置页面
static lv_obj_t* s_screen_settings = nullptr;
static lv_obj_t* s_settings_pet_state_label = nullptr;

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
static ActivePage s_requested_page = ActivePage::PET;
static bool s_page_change_requested = false;
static bool s_touch_tracking = false;
static bool s_swipe_triggered = false;
static int16_t s_touch_start_x = 0;
static int16_t s_touch_start_y = 0;
static uint32_t s_last_swipe_ms = 0;
static uint8_t s_pet_frame_index = 0;
static lv_timer_t* s_idle_anim_timer = nullptr;
static PetState s_displayed_pet_state = PetState::IDLE;
static const void* s_pet_frames[TIQUAN_IDLE_FRAME_COUNT] = {
  &tiquan_idle_frames[0], &tiquan_idle_frames[1], &tiquan_idle_frames[2],
  &tiquan_idle_frames[3], &tiquan_idle_frames[4], &tiquan_idle_frames[5],
  &tiquan_idle_frames[6]
};

static bool s_pet_assets_ready = false;
static bool s_pet_decode_active = false;
static bool s_pet_frame_requested = false;
static uint32_t s_pet_decode_remaining = 0;
static uint32_t s_pet_decode_output = 0;
static uint16_t s_pet_decode_run = 0;
static uint16_t s_pet_decode_color = 0;
static uint8_t s_pet_rle_read_buffer[1024];
static size_t s_pet_rle_read_pos = 0;
static size_t s_pet_rle_read_size = 0;
static uint8_t s_pet_retry_count = 0;
static uint32_t s_pet_retry_at_ms = 0;
static File s_pet_asset_file;
static uint8_t* s_pet_frame_buffer = nullptr;
static lv_img_dsc_t s_pet_frame_dsc = {};

static uint8_t _animation_for_state(PetState pet_state) {
  switch (pet_state) {
    case PetState::IDLE:          return 0;
    case PetState::RUNNING_RIGHT: return 1;
    case PetState::RUNNING_LEFT:  return 2;
    case PetState::WAVING:        return 3;
    case PetState::JUMPING:       return 4;
    case PetState::FAILED:        return 5;
    case PetState::WAITING:       return 6;
    case PetState::RUNNING:       return 7;
    case PetState::REVIEW:        return 8;
    case PetState::LOOK_DIRECTIONS_A: return PET_SPRITE_VERSION >= 2 ? 9 : 0;
    case PetState::LOOK_DIRECTIONS_B: return PET_SPRITE_VERSION >= 2 ? 10 : 0;
    default:                       return 0;
  }
}

static bool _begin_pet_frame(PetState pet_state, uint8_t frame) {
  if (!s_pet_assets_ready || !s_pet_image) return false;
  uint8_t animation = _animation_for_state(pet_state);
  uint8_t frame_count = tiquan_frame_counts[animation];
  if (frame_count == 0) return false;
  frame %= frame_count;
  const TiquanFrameIndex& index = tiquan_frame_index[animation][frame];
  if (!s_pet_asset_file ||
      !s_pet_asset_file.seek(index.offset, SeekSet)) return false;
  s_pet_decode_remaining = index.length;
  s_pet_decode_output = 0;
  s_pet_decode_run = 0;
  s_pet_rle_read_pos = 0;
  s_pet_rle_read_size = 0;
  s_pet_decode_active = true;
  return true;
}

static void _pet_assets_failed() {
  s_pet_decode_active = false;
  s_pet_frame_requested = false;
  s_pet_assets_ready = false;
  state.pet_assets_ready = false;
  if (s_pet_image) {
    s_pet_frame_index %= TIQUAN_IDLE_FRAME_COUNT;
    lv_img_set_src(s_pet_image, s_pet_frames[s_pet_frame_index]);
    lv_obj_invalidate(s_pet_image);
  }
  if (s_pet_asset_file) {
    s_pet_asset_file.close();
  }
  if (s_pet_frame_buffer) {
    heap_caps_free(s_pet_frame_buffer);
    s_pet_frame_buffer = nullptr;
  }
  memset(&s_pet_frame_dsc, 0, sizeof(s_pet_frame_dsc));
  s_pet_rle_read_pos = 0;
  s_pet_rle_read_size = 0;

  // Native USB and radio startup can temporarily retain a few KiB after an
  // upload-triggered reset. Keep retrying long enough for that memory to be
  // released instead of permanently falling back to idle.
  constexpr uint8_t kMaxRetries = 10;
  if (s_pet_retry_count < kMaxRetries) {
    ++s_pet_retry_count;
    s_pet_retry_at_ms = millis() + 3000;
    Serial.printf("[pet] SPIFFS RLE failed; built-in idle, retry %u/%u\n",
                  s_pet_retry_count, kMaxRetries);
  } else {
    s_pet_retry_at_ms = 0;
    Serial.println(F("[pet] SPIFFS RLE disabled; using built-in idle"));
  }
}

void ui_load_pet_assets() {
  if (s_pet_assets_ready || s_pet_frame_buffer) return;

  if (!SPIFFS.begin(false)) {
    Serial.println(F("[pet] SPIFFS mount failed; using built-in idle"));
    _pet_assets_failed();
    return;
  }

  s_pet_asset_file =
    SPIFFS.open("/pets/tiquan-v2/sprites.rle", FILE_READ);
  if (!s_pet_asset_file) {
    s_pet_asset_file = SPIFFS.open("/sprites.rle", FILE_READ);
  }

  const TiquanFrameIndex& last =
    tiquan_frame_index[TIQUAN_ANIMATION_COUNT - 1][7];
  const uint32_t expected_size = last.offset + last.length;
  if (!s_pet_asset_file ||
      static_cast<uint64_t>(s_pet_asset_file.size()) < expected_size) {
    Serial.printf("[pet] SPIFFS RLE missing or too small; need %lu bytes\n",
                  static_cast<unsigned long>(expected_size));
    s_pet_asset_file.close();
    _pet_assets_failed();
    return;
  }

  const size_t free_before =
    heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  const size_t largest_before =
    heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  // Wi-Fi, HTTP, UDP and BLE are initialized before this allocation. Keep a
  // 24 KiB steady-state reserve; the normal post-allocation heap is ~30 KiB,
  // while an upload-triggered reset can temporarily report a few KiB less.
  constexpr size_t kRuntimeReserve = 24U * 1024U;
  if (free_before < TIQUAN_FRAME_BYTES + kRuntimeReserve ||
      largest_before < TIQUAN_FRAME_BYTES) {
    s_pet_asset_file.close();
    Serial.printf("[pet] insufficient safe heap; free=%u largest=%u\n",
                  static_cast<unsigned>(free_before),
                  static_cast<unsigned>(largest_before));
    _pet_assets_failed();
    return;
  }
  s_pet_frame_buffer = static_cast<uint8_t*>(
    heap_caps_malloc(TIQUAN_FRAME_BYTES,
                     MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT));
  if (!s_pet_frame_buffer) {
    s_pet_asset_file.close();
    Serial.printf("[pet] no RAM for frame buffer; free=%u largest=%u\n",
                  static_cast<unsigned>(free_before),
                  static_cast<unsigned>(largest_before));
    _pet_assets_failed();
    return;
  }

  memset(&s_pet_frame_dsc, 0, sizeof(lv_img_dsc_t));
  s_pet_frame_dsc.header.cf = LV_IMG_CF_TRUE_COLOR;
  s_pet_frame_dsc.header.w = TIQUAN_FRAME_WIDTH;
  s_pet_frame_dsc.header.h = TIQUAN_FRAME_HEIGHT;
  s_pet_frame_dsc.data_size = TIQUAN_FRAME_BYTES;
  s_pet_frame_dsc.data = s_pet_frame_buffer;

  s_pet_assets_ready = true;
  state.pet_assets_ready = true;
  s_pet_retry_count = 0;
  s_pet_retry_at_ms = 0;
  s_pet_frame_index = 0;
  s_pet_frame_requested = true;
  Serial.printf("[pet] SPIFFS RLE ready: %lu bytes, %u animations, heap=%u\n",
                static_cast<unsigned long>(s_pet_asset_file.size()),
                TIQUAN_ANIMATION_COUNT,
                static_cast<unsigned>(ESP.getFreeHeap()));
}

static bool _read_pet_rle_record(uint16_t& run, uint16_t& color) {
  if (s_pet_decode_remaining < 4) return false;

  if (s_pet_rle_read_size - s_pet_rle_read_pos < 4) {
    const size_t wanted =
      s_pet_decode_remaining < sizeof(s_pet_rle_read_buffer)
        ? s_pet_decode_remaining
        : sizeof(s_pet_rle_read_buffer);
    const size_t received =
      s_pet_asset_file.read(s_pet_rle_read_buffer, wanted);
    if (received != wanted || received < 4) return false;
    s_pet_rle_read_pos = 0;
    s_pet_rle_read_size = received;
  }

  const uint8_t* record = s_pet_rle_read_buffer + s_pet_rle_read_pos;
  run = uint16_t(record[0]) | (uint16_t(record[1]) << 8);
  color = uint16_t(record[2]) | (uint16_t(record[3]) << 8);
  s_pet_rle_read_pos += 4;
  s_pet_decode_remaining -= 4;
  return run != 0;
}

static void _service_pet_decode() {
  if (!s_pet_decode_active) return;
  while (s_pet_decode_active) {
    if (s_pet_decode_run == 0) {
      if (!_read_pet_rle_record(s_pet_decode_run, s_pet_decode_color)) {
        _pet_assets_failed();
        return;
      }
    }
    const uint16_t pixels = s_pet_decode_run;
    if (s_pet_decode_output + uint32_t(pixels) * 2 > TIQUAN_FRAME_BYTES) {
      _pet_assets_failed();
      return;
    }
    for (uint16_t i = 0; i < pixels; ++i) {
      s_pet_frame_buffer[s_pet_decode_output++] = s_pet_decode_color & 0xff;
      s_pet_frame_buffer[s_pet_decode_output++] = s_pet_decode_color >> 8;
    }
    s_pet_decode_run = 0;
    if (s_pet_decode_output == TIQUAN_FRAME_BYTES) {
      if (s_pet_decode_remaining != 0) {
        _pet_assets_failed();
        return;
      }
      s_pet_decode_active = false;
      state.pet_animation_frame = s_pet_frame_index;
      // The descriptor and backing buffer are reused for every frame.
      // Invalidate it explicitly so this stays correct if LVGL image caching
      // is enabled in a future build.
      lv_img_cache_invalidate_src(&s_pet_frame_dsc);
      lv_img_set_src(s_pet_image, &s_pet_frame_dsc);
      lv_obj_invalidate(s_pet_image);
    }
  }
}

static void _idle_anim_timer_cb(lv_timer_t*) {
  if (!s_pet_image || s_active_page != ActivePage::PET) return;

  if (s_pet_assets_ready) {
    if (s_pet_decode_active || s_pet_frame_requested) return;
    uint8_t animation = _animation_for_state(state.pet_state);
    uint8_t frame_count = tiquan_frame_counts[animation];
    s_pet_frame_index = (s_pet_frame_index + 1) % frame_count;
    s_pet_frame_requested = true;
    return;
  }

  s_pet_frame_index = (s_pet_frame_index + 1) % TIQUAN_IDLE_FRAME_COUNT;
  lv_img_set_src(s_pet_image, s_pet_frames[s_pet_frame_index]);
  lv_obj_invalidate(s_pet_image);
}

static void _enable_gesture_bubble(lv_obj_t* obj) {
  if (!obj) return;
  lv_obj_add_flag(obj, LV_OBJ_FLAG_GESTURE_BUBBLE);
  uint32_t child_count = lv_obj_get_child_cnt(obj);
  for (uint32_t i = 0; i < child_count; ++i) {
    _enable_gesture_bubble(lv_obj_get_child(obj, (int32_t)i));
  }
}
static void _switch_page_by_swipe(int16_t dx, int16_t dy) {
  // 仅识别明显的横向滑动，避免普通点击和上下滚动触发页面切换。
  if (abs(dx) < 55 || abs(dx) <= abs(dy)) return;
  uint32_t now = millis();
  if (now - s_last_swipe_ms < 400) return;
  s_last_swipe_ms = now;

  if (dx < 0) {
    switch (s_active_page) {
      case ActivePage::PET:      ui_show_apps(); break;
      case ActivePage::APPS:     ui_show_settings(); break;
      case ActivePage::SETTINGS: ui_show_pet(); break;
    }
  } else {
    switch (s_active_page) {
      case ActivePage::PET:      ui_show_settings(); break;
      case ActivePage::SETTINGS: ui_show_apps(); break;
      case ActivePage::APPS:     ui_show_pet(); break;
    }
  }
  touchActivity();
  return;

#if 0

  if (dx < 0) {  // 向左：进入下一页
    switch (s_active_page) {
      case ActivePage::PET:      ui_show_apps(); break;
      case ActivePage::APPS:     ui_show_settings(); break;
      case ActivePage::SETTINGS: ui_show_pet(); break;
    }
  } else {        // 向右：返回上一页
    switch (s_active_page) {
      case ActivePage::PET:      ui_show_settings(); break;
      case ActivePage::SETTINGS: ui_show_apps(); break;
      case ActivePage::APPS:     ui_show_pet(); break;
    }
  }
  touchActivity();
}

#endif
}

static void _screen_gesture_cb(lv_event_t* e) {
  (void)e;
  lv_indev_t* indev = lv_indev_get_act();
  if (!indev) return;

  lv_dir_t dir = lv_indev_get_gesture_dir(indev);
  if (dir == LV_DIR_LEFT) {
    _switch_page_by_swipe(-100, 0);
  } else if (dir == LV_DIR_RIGHT) {
    _switch_page_by_swipe(100, 0);
  }
}

static void _set_pet_visual(PetState pet_state) {
  if (!s_pet_face || !s_pet_eye_left || !s_pet_eye_right) return;

  lv_color_t face_color = lv_color_hex(0x243B53);
  lv_color_t accent_color = lv_color_hex(0x38BDF8);
  switch (pet_state) {
    case PetState::RUNNING:  face_color = lv_color_hex(0x164E63); accent_color = lv_color_hex(0x22D3EE); break;
    case PetState::REVIEW:   face_color = lv_color_hex(0x312E81); accent_color = lv_color_hex(0xA78BFA); break;
    case PetState::WAVING:   face_color = lv_color_hex(0x14532D); accent_color = lv_color_hex(0x4ADE80); break;
    case PetState::FAILED:   face_color = lv_color_hex(0x7F1D1D); accent_color = lv_color_hex(0xFB7185); break;
    case PetState::LOOK_DIRECTIONS_A:
    case PetState::LOOK_DIRECTIONS_B: face_color = lv_color_hex(0x0F3D3E); accent_color = lv_color_hex(0x2DD4BF); break;
    case PetState::RUNNING_RIGHT:
    case PetState::RUNNING_LEFT: face_color = lv_color_hex(0x164E63); accent_color = lv_color_hex(0x22D3EE); break;
    case PetState::JUMPING:  face_color = lv_color_hex(0x4C1D95); accent_color = lv_color_hex(0xC084FC); break;
    case PetState::WAITING:  face_color = lv_color_hex(0x713F12); accent_color = lv_color_hex(0xFACC15); break;
    case PetState::IDLE:
    default: break;
  }

  lv_obj_set_style_bg_color(s_pet_face, face_color, 0);
  lv_obj_set_style_border_color(s_pet_face, accent_color, 0);
  lv_obj_set_style_bg_color(s_pet_eye_left, accent_color, 0);
  lv_obj_set_style_bg_color(s_pet_eye_right, accent_color, 0);
}

static const char* _pet_state_text(PetState pet_state) {
  switch (pet_state) {
    case PetState::IDLE:          return "IDLE";
    case PetState::RUNNING:       return "RUNNING";
    case PetState::REVIEW:        return "REVIEW";
    case PetState::WAVING:        return "WAVING";
    case PetState::FAILED:        return "FAILED";
    case PetState::LOOK_DIRECTIONS_A: return "LOOK A";
    case PetState::LOOK_DIRECTIONS_B: return "LOOK B";
    case PetState::RUNNING_RIGHT: return "RUNNING RIGHT";
    case PetState::RUNNING_LEFT:  return "RUNNING LEFT";
    case PetState::JUMPING:       return "JUMPING";
    case PetState::WAITING:       return "WAITING";
    default:                       return "READY";
  }
}

static const char* _pet_state_text_zh(PetState pet_state) {
  switch (pet_state) {
    case PetState::IDLE:          return "待机";
    case PetState::RUNNING:       return "工作中";
    case PetState::REVIEW:        return "审阅";
    case PetState::WAVING:        return "挥手";
    case PetState::FAILED:        return "失败";
    case PetState::LOOK_DIRECTIONS_A: return "观察方向 A";
    case PetState::LOOK_DIRECTIONS_B: return "观察方向 B";
    case PetState::RUNNING_RIGHT: return "向右移动";
    case PetState::RUNNING_LEFT:  return "向左移动";
    case PetState::JUMPING:       return "跳跃";
    case PetState::WAITING:       return "等待输入";
    default:                       return "未知";
  }
}

// ==================== 显示驱动刷新回调 ====================
static void disp_flush_cb(lv_disp_drv_t* disp, const lv_area_t* area, lv_color_t* color_p) {
  uint32_t w = area->x2 - area->x1 + 1;
  uint32_t h = area->y2 - area->y1 + 1;

#if LV_COLOR_16_SWAP
  hal::gfx->draw16bitBeRGBBitmap(area->x1, area->y1,
                                  (uint16_t*)&color_p->full, w, h);
#else
  hal::gfx->draw16bitRGBBitmap(area->x1, area->y1,
                                (uint16_t*)&color_p->full, w, h);
#endif
  lv_disp_flush_ready(disp);
}

// ==================== 触摸输入驱动 ====================
static void touch_read_cb(lv_indev_drv_t* drv, lv_indev_data_t* data) {
  (void)drv;
  int16_t x = 0, y = 0;

  if (!hal::touch_available()) {
    s_touch_tracking = false;
    s_swipe_triggered = false;
    data->state = LV_INDEV_STATE_REL;
    return;
  }

  if (hal::touch_read(&x, &y)) {
    if (!s_touch_tracking) {
      s_touch_start_x = x;
      s_touch_start_y = y;
      s_touch_tracking = true;
      s_swipe_triggered = false;
    } else if (!s_swipe_triggered && !s_slider_interacting) {
      int16_t dx = x - s_touch_start_x;
      int16_t dy = y - s_touch_start_y;
      if (abs(dx) >= 55 && abs(dx) > abs(dy)) {
        _switch_page_by_swipe(dx, dy);
        s_swipe_triggered = true;
      }
    }
    data->point.x = x;
    data->point.y = y;
    data->state = LV_INDEV_STATE_PR;
    touchActivity();
  } else {
    s_touch_tracking = false;
    s_swipe_triggered = false;
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

  // 4. ESP32-C6 没有 PSRAM，按 Arduino_GFX LVGL 示例使用单内部 RAM 缓冲区
  size_t buf_size = LCD_WIDTH * 40 * sizeof(lv_color_t);
  s_buf1 = (lv_color_t*)heap_caps_malloc(buf_size, MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
  if (!s_buf1) {
    s_buf1 = (lv_color_t*)heap_caps_malloc(buf_size, MALLOC_CAP_8BIT);
  }
  if (!s_buf1) {
    Serial.println(F("[ui] LVGL draw buffer allocation FAILED!"));
    return;
  }

  lv_disp_draw_buf_init(&s_draw_buf, s_buf1, nullptr, LCD_WIDTH * 40);

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
  lv_obj_add_event_cb(s_screen_main, _screen_gesture_cb, LV_EVENT_GESTURE, nullptr);
  lv_scr_load(s_screen_main);

  // 8. 初始化所有页面
  _ui_init_pet_screen();
  _ui_init_settings_screen();
  _ui_init_apps_screen();
  _enable_gesture_bubble(s_screen_main);
  _enable_gesture_bubble(s_screen_settings);
  _enable_gesture_bubble(s_screen_apps);
  lv_obj_invalidate(s_screen_main);
  lv_refr_now(nullptr);
  Serial.println(F("[ui] init done"));
}

// ==================== 创建桌宠主界面 ====================
static void _ui_init_pet_screen() {
  // 背景色 (深色主题)
  lv_obj_set_style_bg_color(s_screen_main, lv_color_hex(0x1a1a2e), 0);

  // 首页标题
  lv_obj_t* title = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(title, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(title, lv_color_hex(0x38BDF8), 0);
  lv_label_set_text(title, "AgentAura");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 14);

  // 使用 LVGL 原生图形绘制桌宠，避免没有图片资源时首页只剩占位文字。
  s_pet_face = lv_obj_create(s_screen_main);
  lv_obj_set_size(s_pet_face, 178, 178);
  lv_obj_align(s_pet_face, LV_ALIGN_CENTER, 0, -18);
  lv_obj_set_style_radius(s_pet_face, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(s_pet_face, lv_color_hex(0x243B53), 0);
  lv_obj_set_style_border_width(s_pet_face, 4, 0);
  lv_obj_set_style_border_color(s_pet_face, lv_color_hex(0x38BDF8), 0);
  lv_obj_set_style_pad_all(s_pet_face, 0, 0);
  lv_obj_clear_flag(s_pet_face, LV_OBJ_FLAG_SCROLLABLE);

  s_pet_eye_left = lv_obj_create(s_pet_face);
  lv_obj_set_size(s_pet_eye_left, 25, 36);
  lv_obj_align(s_pet_eye_left, LV_ALIGN_CENTER, -34, -20);
  lv_obj_set_style_radius(s_pet_eye_left, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(s_pet_eye_left, lv_color_hex(0x38BDF8), 0);
  lv_obj_set_style_border_width(s_pet_eye_left, 0, 0);
  lv_obj_set_style_pad_all(s_pet_eye_left, 0, 0);

  s_pet_eye_right = lv_obj_create(s_pet_face);
  lv_obj_set_size(s_pet_eye_right, 25, 36);
  lv_obj_align(s_pet_eye_right, LV_ALIGN_CENTER, 34, -20);
  lv_obj_set_style_radius(s_pet_eye_right, LV_RADIUS_CIRCLE, 0);
  lv_obj_set_style_bg_color(s_pet_eye_right, lv_color_hex(0x38BDF8), 0);
  lv_obj_set_style_border_width(s_pet_eye_right, 0, 0);
  lv_obj_set_style_pad_all(s_pet_eye_right, 0, 0);

  lv_obj_t* mouth = lv_obj_create(s_pet_face);
  lv_obj_set_size(mouth, 58, 10);
  lv_obj_align(mouth, LV_ALIGN_CENTER, 0, 38);
  lv_obj_set_style_radius(mouth, 5, 0);
  lv_obj_set_style_bg_color(mouth, lv_color_hex(0x38BDF8), 0);
  lv_obj_set_style_border_width(mouth, 0, 0);
  lv_obj_set_style_pad_all(mouth, 0, 0);

  // 使用指定的 Codex 缇犬 v2 idle 图集作为默认桌宠。
  lv_obj_add_flag(s_pet_face, LV_OBJ_FLAG_HIDDEN);
  s_pet_image = lv_img_create(s_screen_main);
  lv_obj_set_size(s_pet_image, TIQUAN_IDLE_FRAME_WIDTH, TIQUAN_IDLE_FRAME_HEIGHT);
  lv_obj_align(s_pet_image, LV_ALIGN_CENTER, 0, -18);
  lv_img_set_src(s_pet_image, s_pet_frames[0]);
  s_idle_anim_timer = lv_timer_create(_idle_anim_timer_cb, 500, nullptr);

  // 状态文字放在图像下方，不再用 AURA 作为唯一首页内容。
  s_pet_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_pet_label, &lv_font_montserrat_20, 0);
  lv_obj_set_style_text_color(s_pet_label, lv_color_hex(0xFFFFFF), 0);
  lv_label_set_text(s_pet_label, "IDLE");
  lv_obj_align(s_pet_label, LV_ALIGN_CENTER, 0, 92);

  s_home_status_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_home_status_label, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(s_home_status_label, lv_color_hex(0x94A3B8), 0);
  lv_label_set_text(s_home_status_label, "Ready  |  USB / WiFi / BLE");
  lv_obj_align(s_home_status_label, LV_ALIGN_TOP_MID, 0, 42);

  s_home_hint_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_home_hint_label, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(s_home_hint_label, lv_color_hex(0x64748B), 0);
  lv_label_set_text(s_home_hint_label, "Hold BOOT for Apps");
  lv_obj_align(s_home_hint_label, LV_ALIGN_BOTTOM_LEFT, 8, -6);

  // 消息气泡 (宠物的说话内容)
  s_msg_label = lv_label_create(s_screen_main);
  lv_obj_set_width(s_msg_label, LCD_WIDTH - 32);
  lv_label_set_long_mode(s_msg_label, LV_LABEL_LONG_WRAP);
  lv_obj_set_style_text_font(s_msg_label, &lv_font_agentaura_16, 0);
  lv_obj_set_style_text_align(s_msg_label, LV_TEXT_ALIGN_CENTER, 0);
  lv_obj_set_style_text_color(s_msg_label, lv_color_hex(0xF8FAFC), 0);
  lv_obj_set_style_bg_color(s_msg_label, lv_color_hex(0x0F172A), 0);
  lv_obj_set_style_bg_opa(s_msg_label, LV_OPA_80, 0);
  lv_obj_set_style_radius(s_msg_label, 10, 0);
  lv_obj_set_style_pad_all(s_msg_label, 8, 0);
  lv_obj_align(s_msg_label, LV_ALIGN_TOP_MID, 0, 70);
  lv_label_set_text(s_msg_label, "");
  lv_obj_add_flag(s_msg_label, LV_OBJ_FLAG_HIDDEN);

  // 电池信息 (右下角)
  s_battery_label = lv_label_create(s_screen_main);
  lv_obj_set_style_text_font(s_battery_label, &lv_font_montserrat_12, 0);
  lv_obj_set_style_text_color(s_battery_label, lv_color_hex(0x22C55E), 0);
  lv_obj_align(s_battery_label, LV_ALIGN_BOTTOM_RIGHT, -5, -5);
  lv_label_set_text(s_battery_label, "BAT 100%");

  _set_pet_visual(state.pet_state);

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
  uint32_t now = millis();

  // 在调用 handler 的同一任务推进 tick，确保 LVGL 动画定时器持续运行。
  static uint32_t s_last_tick = now;
  uint32_t elapsed = now - s_last_tick;
  if (elapsed > 0) {
    lv_tick_inc(elapsed);
    s_last_tick = now;
  }

  if (!s_pet_assets_ready && s_pet_retry_at_ms != 0 &&
      static_cast<int32_t>(now - s_pet_retry_at_ms) >= 0) {
    s_pet_retry_at_ms = 0;
    ui_load_pet_assets();
  }

  // React to externally synchronized state before starting another frame.
  // Previously this ran only in the 500 ms data refresh block, allowing an
  // already requested idle frame to win after the Agent state had changed.
  if (state.pet_state != s_displayed_pet_state) {
    s_displayed_pet_state = state.pet_state;
    s_pet_frame_index = 0;
    s_pet_decode_active = false;
    s_pet_decode_run = 0;
    s_pet_decode_remaining = 0;
    s_pet_frame_requested = s_pet_assets_ready;
    state.pet_animation_row = _animation_for_state(state.pet_state);
    state.pet_animation_frame = 0;
    Serial.printf("[pet] animation switch: state=%s row=%u assets=%s\n",
                  _pet_state_text(state.pet_state),
                  static_cast<unsigned>(state.pet_animation_row),
                  s_pet_assets_ready ? "SPIFFS" : "idle-fallback");
  }

  if (s_pet_assets_ready && s_pet_frame_requested &&
      !s_pet_decode_active) {
    s_pet_frame_requested = false;
    if (!_begin_pet_frame(state.pet_state, s_pet_frame_index)) {
      _pet_assets_failed();
    }
  }
  _service_pet_decode();

  if (s_page_change_requested) {
    s_page_change_requested = false;

    lv_obj_t* target = nullptr;
    switch (s_requested_page) {
      case ActivePage::PET:
        ui_hide_approval();
        target = s_screen_main;
        break;
      case ActivePage::SETTINGS:
        target = s_screen_settings;
        break;
      case ActivePage::APPS:
        target = s_screen_apps;
        break;
    }

    if (target) {
      if (lv_scr_act() != target) lv_scr_load(target);
      lv_obj_invalidate(target);
      s_active_page = s_requested_page;
      lv_refr_now(nullptr);
      Serial.printf("[ui] active page: %u\n", static_cast<unsigned>(s_active_page));
    }
  }

  static uint32_t s_last_lv_handler = 0;
  if (s_last_lv_handler == 0 || now - s_last_lv_handler >= 5) {
    s_last_lv_handler = now;
    lv_timer_handler();
  }

  // 更新 UI 数据 (简单状态同步，后续可优化)
  static uint32_t s_last_update = 0;

  if (now - s_last_update > 500) {  // 每500ms更新一次
    s_last_update = now;

    // 更新电池
    char batt[16];
    snprintf(batt, sizeof(batt), "%s %d%%",
             state.battery_charging ? "CHG" : "BAT",
             state.battery_percent);
    lv_label_set_text(s_battery_label, batt);

    // 更新桌宠图形和状态文字
    lv_label_set_text(s_pet_label, _pet_state_text(state.pet_state));
    if (s_settings_pet_state_label) {
      char pet_state_text[40];
      snprintf(pet_state_text, sizeof(pet_state_text), "状态: %s",
               _pet_state_text_zh(state.pet_state));
      lv_label_set_text(s_settings_pet_state_label, pet_state_text);
    }
    _sync_settings_controls();
    _set_pet_visual(state.pet_state);
    char connection[48];
    snprintf(connection, sizeof(connection), "%s  |  %s  |  %s",
             state.usb_connected ? "USB" : "USB -",
             state.wifi_connected ? "WiFi" : "WiFi -",
             state.ble_connected ? "BLE" : "BLE -");
    lv_label_set_text(s_home_status_label, connection);

    static PetState s_last_logged_pet_state = static_cast<PetState>(0xFF);
    if (state.pet_state != s_last_logged_pet_state) {
      Serial.printf("[ui] render pet state: %s\n", _pet_state_text(state.pet_state));
      s_last_logged_pet_state = state.pet_state;
    }

    // 更新消息气泡
    bool show_message =
      state.msg_timestamp > 0 &&
      state.pet_message.length() > 0 &&
      now - state.msg_timestamp < 10000;
    if (show_message) {
      if (strcmp(lv_label_get_text(s_msg_label), state.pet_message.c_str()) != 0) {
        lv_label_set_text(s_msg_label, state.pet_message.c_str());
      }
      lv_obj_clear_flag(s_msg_label, LV_OBJ_FLAG_HIDDEN);
      lv_obj_move_foreground(s_msg_label);
    } else {
      lv_obj_add_flag(s_msg_label, LV_OBJ_FLAG_HIDDEN);
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
  lv_obj_add_event_cb(s_screen_settings, _screen_gesture_cb, LV_EVENT_GESTURE, nullptr);

  // 背景色
  lv_obj_set_style_bg_color(s_screen_settings, lv_color_hex(0x1a1a2e), 0);

  // 标题
  lv_obj_t* title = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(title, &lv_font_agentaura_16, 0);
  lv_obj_set_style_text_color(title, lv_color_hex(0x0EA5E9), 0);
  lv_label_set_text(title, "设置");
  lv_obj_align(title, LV_ALIGN_TOP_MID, 0, 15);

  // 亮度滑块
  lv_obj_t* brt_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(brt_label, &lv_font_agentaura_16, 0);
  lv_obj_set_style_text_color(brt_label, lv_color_hex(0x94A3B8), 0);
  lv_label_set_text(brt_label, "亮度");
  lv_obj_align(brt_label, LV_ALIGN_TOP_LEFT, 20, 65);

  s_brightness_slider = lv_slider_create(s_screen_settings);
  lv_obj_set_size(s_brightness_slider, 190, 22);
  lv_obj_align(s_brightness_slider, LV_ALIGN_TOP_LEFT, 80, 62);
  lv_obj_set_ext_click_area(s_brightness_slider, 14);
  lv_slider_set_range(s_brightness_slider, 0, 255);
  lv_slider_set_value(s_brightness_slider, state.brightness, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(s_brightness_slider, lv_color_hex(0x333344), LV_PART_MAIN);
  lv_obj_set_style_bg_color(s_brightness_slider, lv_color_hex(0x0EA5E9), LV_PART_INDICATOR);

  s_brightness_value_label = lv_label_create(s_screen_settings);
  lv_obj_set_width(s_brightness_value_label, 52);
  lv_obj_set_style_text_font(s_brightness_value_label, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_align(s_brightness_value_label, LV_TEXT_ALIGN_RIGHT, 0);
  lv_obj_set_style_text_color(s_brightness_value_label, lv_color_hex(0x38BDF8), 0);
  lv_label_set_text_fmt(s_brightness_value_label, "%u", state.brightness);
  lv_obj_align(s_brightness_value_label, LV_ALIGN_TOP_LEFT, 292, 64);
  lv_obj_add_event_cb(s_brightness_slider, _brightness_slider_event_cb,
                      LV_EVENT_ALL, s_brightness_value_label);

  // 音量滑块
  lv_obj_t* vol_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(vol_label, &lv_font_agentaura_16, 0);
  lv_obj_set_style_text_color(vol_label, lv_color_hex(0x94A3B8), 0);
  lv_label_set_text(vol_label, "音量");
  lv_obj_align(vol_label, LV_ALIGN_TOP_LEFT, 20, 125);

  s_volume_slider = lv_slider_create(s_screen_settings);
  lv_obj_set_size(s_volume_slider, 190, 22);
  lv_obj_align(s_volume_slider, LV_ALIGN_TOP_LEFT, 80, 122);
  lv_obj_set_ext_click_area(s_volume_slider, 14);
  lv_slider_set_range(s_volume_slider, 0, 100);
  lv_slider_set_value(s_volume_slider, state.volume, LV_ANIM_OFF);
  lv_obj_set_style_bg_color(s_volume_slider, lv_color_hex(0x333344), LV_PART_MAIN);
  lv_obj_set_style_bg_color(s_volume_slider, lv_color_hex(0x22C55E), LV_PART_INDICATOR);

  s_volume_value_label = lv_label_create(s_screen_settings);
  lv_obj_set_width(s_volume_value_label, 52);
  lv_obj_set_style_text_font(s_volume_value_label, &lv_font_montserrat_16, 0);
  lv_obj_set_style_text_align(s_volume_value_label, LV_TEXT_ALIGN_RIGHT, 0);
  lv_obj_set_style_text_color(s_volume_value_label, lv_color_hex(0x4ADE80), 0);
  lv_label_set_text_fmt(s_volume_value_label, "%u", state.volume);
  lv_obj_align(s_volume_value_label, LV_ALIGN_TOP_LEFT, 292, 124);
  lv_obj_add_event_cb(s_volume_slider, _volume_slider_event_cb,
                      LV_EVENT_ALL, s_volume_value_label);

  // 当前宠物状态，与网页管理页使用同一组 11 状态语义。
  s_settings_pet_state_label = lv_label_create(s_screen_settings);
  lv_obj_set_style_text_font(s_settings_pet_state_label, &lv_font_agentaura_16, 0);
  lv_obj_set_style_text_color(s_settings_pet_state_label, lv_color_hex(0x94A3B8), 0);
  char pet_state_text[40];
  snprintf(pet_state_text, sizeof(pet_state_text), "状态: %s",
           _pet_state_text_zh(state.pet_state));
  lv_label_set_text(s_settings_pet_state_label, pet_state_text);
  lv_obj_align(s_settings_pet_state_label, LV_ALIGN_TOP_LEFT, 20, 190);

  // 返回按钮 (触摸区域, 右下角)
  lv_obj_t* back_btn = lv_btn_create(s_screen_settings);
  lv_obj_set_size(back_btn, 80, 36);
  lv_obj_align(back_btn, LV_ALIGN_BOTTOM_RIGHT, -20, -20);
  lv_obj_set_style_bg_color(back_btn, lv_color_hex(0x0EA5E9), 0);
  lv_obj_t* back_lbl = lv_label_create(back_btn);
  lv_obj_set_style_text_font(back_lbl, &lv_font_agentaura_16, 0);
  lv_label_set_text(back_lbl, "返回");
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
  lv_obj_add_event_cb(s_screen_apps, _screen_gesture_cb, LV_EVENT_GESTURE, nullptr);

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
  // 仅在 setup() 阶段调用（WiFi 连接前），用 lv_refr_now 强制渲染首帧。
  // loop() 中不调用此函数——主循环依赖 lv_timer_handler() 异步渲染，避免阻塞 HTTP。
  lv_obj_t* active = lv_scr_act();
  if (!active) return;
  lv_obj_invalidate(active);
  lv_refr_now(NULL);
}

void ui_show_pet() {
  s_requested_page = ActivePage::PET;
  s_page_change_requested = true;
}

void ui_show_settings() {
  s_requested_page = ActivePage::SETTINGS;
  s_page_change_requested = true;
}

void ui_show_apps() {
  s_requested_page = ActivePage::APPS;
  s_page_change_requested = true;
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
