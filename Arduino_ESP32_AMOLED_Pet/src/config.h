/*
 * ============================================================
 *  config.h 闁?闁稿繈鍔岄惇顒勬煀瀹ュ洨鏋?(鐎殿喗娲滈弫?pin_config.h)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_CONFIG_H
#define AGENTAURA_CONFIG_H

#include "pin_config.h"


// ==================== 缂侇垵宕电划铏规偘鐏炶壈绀?====================
// 闁告凹鍨版慨鈺呭礉閵娧勬毎闁归晲鑳堕悽濠氬籍閸洘锛?
#define STARTUP_ANIM_MS     2000UL
// Agent init 闁绘鍩栭埀顑挎祰缁夋挳寮幆鏉挎闁告柣鍔岀欢鐔煎嫉?#define INIT_AUTO_IDLE_MS   5000UL
// 閻忕偛绻愮粻鐑藉籍閻樿櫕鎯欏ù锝嗙矎閸ゆ粓宕濋妸銉ョ秮闁哄棙顨夌粔鎾籍?(30缂?
#define SCREEN_DIM_TIMEOUT  30000UL
// 閻忕偛绻愮粻鐑藉籍閻樿櫕鎯欏ù锝嗙矎閸ゆ粓宕濋妸锔跨礀閻忕偛绻楃粔鎾籍?(2闁告帒妫濋幐?
#define SCREEN_OFF_TIMEOUT  120000UL
// 调试阶段默认常亮，不自动降亮或灭屏
#define SCREEN_ALWAYS_ON    1

// ==================== LVGL 闂佹澘绉堕悿?====================
#define LVGL_TICK_MS        5           // LVGL 闊洤鍟抽悜锕傛⒒閹绢喗顓?
#define LVGL_BUF_SIZE       (LCD_WIDTH * 40) // LVGL 缂傚倹鎸搁崯鍧楀礌閸濆嫨浜ｉ悘?
// ==================== 闂侇偅鐭穱濠囧础韫囨凹鍞?====================
#define CMD_BUF_SIZE        256
// 閻庡厜鍓濇竟鎺旀惥閸涱喗顦?(缂?
#define APPROVAL_TIMEOUT_S  60
// 濡増绻傜€瑰啿螞閳ь剟寮婚妷鈺傦紵闂?(缂?
#define QUOTA_CHECK_INTERVAL 30
#define WIFI_SCAN_MAX       20

// ==================== 闁绘せ鏅濋幃濠囧箰婢舵劖鏆?====================
#define BOOT_DEBOUNCE_MS    50
#define PWR_LONG_PRESS_MS   6000UL
#define BOOT_LONG_PRESS_MS  1000UL
// ==================== 閻庡湱濮锋晶鍧楁偐閼哥鍋?====================
enum class PetState : uint8_t {
  IDLE,
  RUNNING,
  THINKING,
  SPEAKING,
  ERROR,
  SLEEP,
  OFFLINE,
  RUNNING_RIGHT,
  RUNNING_LEFT,
  JUMPING,
  WAITING
};

enum class AgentType : uint8_t {
  NONE = 0,
  CLAUDE,
  CODEX,
  OTHER
};

// ==================== 闁藉啯绻勬晶?WiFi闁绘鍩栭埀?====================
enum class RadioState : uint8_t {
  ON,
  OFF,
  PENDING
};

#endif // AGENTAURA_CONFIG_H


