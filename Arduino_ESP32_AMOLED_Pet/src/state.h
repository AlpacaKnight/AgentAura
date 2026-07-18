/*
 * ============================================================
 *  state.h — 全局运行时状态
 *  参考环形灯固件 state.h/cpp 的架构
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_STATE_H
#define AGENTAURA_STATE_H

#include <Arduino.h>
#include "config.h"

// ==================== Agent 额度状态 ====================
struct QuotaState {
  float total_quota    = 100.0f;   // 总额度
  float used_quota     = 0.0f;     // 已用额度
  float h5_total       = 5.0f;     // 5 小时总额度
  float h5_used        = 0.0f;     // 5 小时已用
  float h5_remaining   = 5.0f;     // 5 小时余量
  uint32_t refresh_ts  = 0;        // 刷新时间戳 (Unix)
  int32_t refresh_sec  = 0;        // 刷新倒计时秒数
};

// ==================== 审批状态 ====================
struct ApprovalRequest {
  bool     active    = false;
  String   id;
  String   agent_type;
  String   title;
  String   description;
  String   confirm_text;
  String   reject_text;
  uint32_t timeout_s = APPROVAL_TIMEOUT_S;
  uint32_t start_ms  = 0;
};

// ==================== 运行时状态 ====================
struct RuntimeState {
  // 宠物状态
  PetState  pet_state    = PetState::IDLE;
  bool      pet_assets_ready = false;
  uint8_t   pet_animation_row = 0;
  uint8_t   pet_animation_frame = 0;
  AgentType agent_type   = AgentType::NONE;
  String    agent_name;                    // Agent 显示名称
  String    agent_state = "idle";          // PetDesktop AgentState

  // 连接状态
  bool      usb_connected  = false;
  bool      wifi_connected = false;
  bool      ble_connected  = false;
  bool      mqtt_connected = false;
  bool      ws_connected   = false;

  // 设置
  uint8_t   brightness     = DEFAULT_BRIGHTNESS;
  uint8_t   volume         = DEFAULT_VOLUME;
  RadioState ble_enabled   = RadioState::ON;
  RadioState wifi_enabled  = RadioState::ON;

  // Agent 额度
  QuotaState quota;

  // 审批
  ApprovalRequest approval;

  // 屏幕管理
  bool      screen_on      = true;
  bool      screen_dim     = false;
  uint32_t  last_activity  = 0;

  // 宠物消息
  String    pet_message;                   // 当前说话气泡内容
  uint32_t  msg_timestamp   = 0;

  // 电量
  uint8_t   battery_percent = 0;
  bool      battery_charging = false;
  float     battery_voltage = 0.0f;
};

extern RuntimeState state;

// ==================== 连接状态标记 ====================
struct ConnectionFlags {
  bool usb  = false;
  bool http = false;
  bool ws   = false;
  bool udp  = false;
  bool mqtt = false;
  bool ble  = false;
};
extern ConnectionFlags conn;

// ==================== 函数声明 ====================
String getStateJson();                    // 生成完整状态 JSON
String getPetStateString(PetState ps);    // 宠物状态转字符串
String getAgentTypeString(AgentType at);  // Agent 类型转字符串

void setPetState(PetState ps);
void setAgentType(AgentType at, const String& name);
void setBrightness(uint8_t v);
void setVolume(uint8_t v);
void setBleEnabled(RadioState rs);
void setWifiEnabled(RadioState rs);
void setPetMessage(const String& message);

// 额度管理
bool isH5Depleted();                      // 5 小时额度是否耗尽
void updateQuota(const QuotaState& q);    // 更新额度
void setRefreshCountdown(int32_t sec);    // 设置刷新倒计时

// 屏幕管理
void touchActivity();                     // 触摸活动标记
void setScreenOn(bool on);
void setScreenDim(bool dim);

// 审批管理
void setApprovalRequest(const ApprovalRequest& req);
void clearApproval();

#endif // AGENTAURA_STATE_H
