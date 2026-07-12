/*
 * ============================================================
 *  state.cpp — 全局运行时状态实现
 * ============================================================
 */
#include "state.h"
#include <ArduinoJson.h>

RuntimeState state;
ConnectionFlags conn;

// ==================== 宠物状态字符串 ====================
String getPetStateString(PetState ps) {
  switch (ps) {
    case PetState::IDLE:     return "idle";
    case PetState::RUNNING:  return "running";
    case PetState::THINKING: return "thinking";
    case PetState::SPEAKING: return "speaking";
    case PetState::ERROR:    return "error";
    case PetState::SLEEP:    return "sleep";
    case PetState::OFFLINE:  return "offline";
    default:                 return "unknown";
  }
}

String getAgentTypeString(AgentType at) {
  switch (at) {
    case AgentType::CLAUDE: return "claude";
    case AgentType::CODEX:  return "codex";
    case AgentType::OTHER:  return "other";
    default:                return "none";
  }
}

// ==================== 状态设置 ====================
void setPetState(PetState ps) {
  state.pet_state = ps;
}

void setAgentType(AgentType at, const String& name) {
  state.agent_type = at;
  state.agent_name = name;
}

void setBrightness(uint8_t v) {
  state.brightness = constrain(v, 0, 255);
}

void setVolume(uint8_t v) {
  state.volume = constrain(v, 0, 100);
}

void setBleEnabled(RadioState rs) {
  state.ble_enabled = rs;
}

void setWifiEnabled(RadioState rs) {
  state.wifi_enabled = rs;
}

// ==================== 额度管理 ====================
bool isH5Depleted() {
  return state.quota.h5_remaining <= 0.01f;
}

void updateQuota(const QuotaState& q) {
  state.quota = q;
}

void setRefreshCountdown(int32_t sec) {
  state.quota.refresh_sec = sec;
}

// ==================== 屏幕管理 ====================
void touchActivity() {
  state.last_activity = millis();
  if (!state.screen_on) setScreenOn(true);
  if (state.screen_dim) setScreenDim(false);
}

void setScreenOn(bool on) {
  state.screen_on = on;
  state.last_activity = millis();
}

void setScreenDim(bool dim) {
  state.screen_dim = dim;
}

// ==================== 审批管理 ====================
void setApprovalRequest(const ApprovalRequest& req) {
  state.approval = req;
  state.approval.active = true;
  state.approval.start_ms = millis();
}

void clearApproval() {
  state.approval.active = false;
  state.approval.id = "";
}

// ==================== 生成完整状态 JSON ====================
String getStateJson() {
  JsonDocument doc;

  doc["fw"] = FW_VERSION;
  doc["device"] = DEVICE_MODEL;

  // 宠物状态
  doc["pet"]["state"] = getPetStateString(state.pet_state);
  doc["pet"]["emotion"] = "";
  if (state.pet_message.length() > 0) {
    doc["pet"]["message"] = state.pet_message;
  }
  doc["pet"]["h5_depleted"] = isH5Depleted();

  // Agent
  doc["agent"]["type"] = getAgentTypeString(state.agent_type);
  doc["agent"]["name"] = state.agent_name;

  // 连接
  doc["connections"]["usb"]  = conn.usb;
  doc["connections"]["wifi"] = state.wifi_connected;
  doc["connections"]["ble"]  = state.ble_connected;
  doc["connections"]["mqtt"] = state.mqtt_connected;
  doc["connections"]["ws"]   = state.ws_connected;

  // 设置
  doc["settings"]["brightness"]  = state.brightness;
  doc["settings"]["volume"]      = state.volume;
  doc["settings"]["ble_enabled"] = (state.ble_enabled == RadioState::ON);
  doc["settings"]["wifi_enabled"] = (state.wifi_enabled == RadioState::ON);

  // 额度
  doc["quota"]["total"]      = state.quota.total_quota;
  doc["quota"]["used"]       = state.quota.used_quota;
  doc["quota"]["h5_total"]   = state.quota.h5_total;
  doc["quota"]["h5_used"]    = state.quota.h5_used;
  doc["quota"]["h5_remaining"] = state.quota.h5_remaining;
  doc["quota"]["refresh_sec"] = state.quota.refresh_sec;

  // 电池
  doc["battery"]["percent"]  = state.battery_percent;
  doc["battery"]["charging"] = state.battery_charging;
  doc["battery"]["voltage"]  = state.battery_voltage;

  // 审批
  doc["approval"]["active"] = state.approval.active;
  if (state.approval.active) {
    doc["approval"]["id"] = state.approval.id;
    doc["approval"]["title"] = state.approval.title;
    doc["approval"]["description"] = state.approval.description;
  }

  String output;
  serializeJson(doc, output);
  return output;
}