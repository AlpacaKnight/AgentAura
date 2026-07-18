/*
 * ============================================================
 *  command.cpp — 统一指令解析器实现
 *
 *  处理来自 USB、BLE、WiFi (HTTP/WS/UDP) 的文本指令和 JSON 指令
 * ============================================================
 */
#include "command.h"
#include "state.h"
#include "storage.h"
#include "config.h"
#include "comm/wifi_manager.h"
#include "comm/ble_server.h"
#include "comm/comm_manager.h"
#include "hal/display.h"
#include "hal/audio.h"
#include "ui/ui_manager.h"
#include <ArduinoJson.h>

namespace cmd {

static String s_help_text =
  F("=== AgentAura Commands ===\n"
    "  state                         - 查询完整状态 JSON\n"
    "  pet state <V1_STATE>          - 设置九种标准宠物状态\n"
    "  pet speak TEXT                - 宠物说话气泡\n"
    "  agent type CLAUDE|CODEX|OTHER - 设置 Agent 类型\n"
    "  wifi on|off                   - 开关 WiFi\n"
    "  wifi SSID,PASSWORD            - 配置 WiFi 连接\n"
    "  bluetooth on|off              - 开关蓝牙\n"
    "  brightness N                  - 设置亮度 (0-255)\n"
    "  volume N                      - 设置音量 (0-100)\n"
    "  screen settings               - 切换至设置页面\n"
    "  screen apps                   - 切换至 App 启动器\n"
    "  screen pet                    - 返回桌宠主界面\n"
    "  help                          - 显示此帮助\n"
    "  reset                         - 重启设备\n");

static bool setPetStateFromName(String value) {
  value.trim();
  value.toLowerCase();
  value.replace('-', '_');

  if (value == "idle" || value == "sleep" || value == "offline") {
    setPetState(PetState::IDLE);
  } else if (value == "running_right" || value == "right") {
    setPetState(PetState::RUNNING_RIGHT);
  } else if (value == "running_left" || value == "left") {
    setPetState(PetState::RUNNING_LEFT);
  } else if (value == "waving" || value == "wave" || value == "speaking") {
    setPetState(PetState::WAVING);
  } else if (value == "jumping" || value == "jump") {
    setPetState(PetState::JUMPING);
  } else if (value == "failed" || value == "fail" || value == "error") {
    setPetState(PetState::FAILED);
  } else if (value == "waiting" || value == "wait") {
    setPetState(PetState::WAITING);
  } else if (value == "running" || value == "working") {
    setPetState(PetState::RUNNING);
  } else if (value == "review" || value == "reviewing" || value == "thinking") {
    setPetState(PetState::REVIEW);
  } else if (value == "look_directions_a" || value == "look_a") {
    setPetState(PetState::LOOK_DIRECTIONS_A);
  } else if (value == "look_directions_b" || value == "look_b") {
    setPetState(PetState::LOOK_DIRECTIONS_B);
  } else {
    return false;
  }
  return true;
}

// ==================== 文本指令解析 ====================
String handleText(const String& cmd) {
  if (cmd.length() == 0) return "";

  String lower = cmd;
  lower.toLowerCase();
  String resp = "";

  // state
  if (lower == "state") {
    return getStateJson();
  }

  // help
  if (lower == "help") {
    return s_help_text;
  }

  // reset
  if (lower == "reset") {
    delay(100);
    ESP.restart();
    return "";
  }

  // 空格分割
  int sp = cmd.indexOf(' ');
  String verb = (sp > 0) ? cmd.substring(0, sp) : cmd;
  String args = (sp > 0) ? cmd.substring(sp + 1) : "";
  verb.toLowerCase();

  // ---- pet 命令 ----
  if (verb == "pet") {
    sp = args.indexOf(' ');
    String sub = (sp > 0) ? args.substring(0, sp) : args;
    String val = (sp > 0) ? args.substring(sp + 1) : "";
    sub.toLowerCase();

    if (sub == "state" && val.length() > 0) {
      if (!setPetStateFromName(val)) return "ERR: unknown pet state";
      return "OK: pet state -> " + getPetStateString(state.pet_state);
    }

    if (sub == "speak" && val.length() > 0) {
      state.pet_message = val;
      state.msg_timestamp = millis();
      return "OK: pet says \"" + val + "\"";
    }

    return "ERR: usage: pet state [idle|running-right|running-left|waving|jumping|failed|waiting|running|review|look-directions-a|look-directions-b]";
  }

  // ---- agent 命令 ----
  if (verb == "agent") {
    sp = args.indexOf(' ');
    String sub = (sp > 0) ? args.substring(0, sp) : args;
    String val = (sp > 0) ? args.substring(sp + 1) : "";
    sub.toLowerCase();

    if (sub == "type") {
      val.toUpperCase();
      if (val == "CLAUDE") setAgentType(AgentType::CLAUDE, "Claude");
      else if (val == "CODEX") setAgentType(AgentType::CODEX, "Codex");
      else if (val == "OTHER") setAgentType(AgentType::OTHER, val);
      else return "ERR: unknown agent type";
      return "OK: agent type -> " + getAgentTypeString(state.agent_type);
    }
    return "ERR: usage: agent type [CLAUDE|CODEX|OTHER]";
  }

  // ---- wifi 命令 ----
  if (verb == "wifi") {
    args.toLowerCase();
    if (args == "on") {
      comm::wifi_toggle(true);
      return "OK: wifi enabled";
    }
    if (args == "off") {
      comm::wifi_toggle(false);
      return "OK: wifi disabled";
    }
    // wifi SSID,PASSWORD
    int comma = args.indexOf(',');
    if (comma > 0) {
      String ssid = args.substring(0, comma);
      String pass = args.substring(comma + 1);
      ssid.trim(); pass.trim();
      comm::wifi_connect(ssid, pass);
      return "OK: connecting to " + ssid;
    }
    return comm::wifi_state_json();
  }

  // ---- bluetooth 命令 ----
  if (verb == "bluetooth" || verb == "ble") {
    args.toLowerCase();
    if (args == "on") {
      comm::ble_toggle(true);
      return "OK: bluetooth enabled";
    }
    if (args == "off") {
      comm::ble_toggle(false);
      return "OK: bluetooth disabled";
    }
    return comm::ble_is_running() ? "BLE: running" : "BLE: stopped";
  }

  // ---- brightness 命令 ----
  if (verb == "brightness") {
    uint8_t v = (uint8_t)args.toInt();
    if (args.length() > 0 && v >= 0 && v <= 255) {
      setBrightness(v);
      hal::display_set_brightness(v);
      storage::saveBrightness(v);
      return "OK: brightness -> " + String(v);
    }
    return "ERR: brightness 0-255";
  }

  // ---- volume 命令 ----
  if (verb == "volume") {
    uint8_t v = (uint8_t)args.toInt();
    if (args.length() > 0 && v >= 0 && v <= 100) {
      setVolume(v);
      hal::audio_set_volume(v);
      storage::saveVolume(v);
      return "OK: volume -> " + String(v);
    }
    return "ERR: volume 0-100";
  }

  // ---- screen 页面切换 ----
  if (verb == "screen") {
    args.toLowerCase();
    if (args == "settings") {
      ui::ui_show_settings();
      return "OK: switched to settings";
    }
    if (args == "apps") {
      ui::ui_show_apps();
      return "OK: switched to apps";
    }
    if (args == "pet") {
      ui::ui_show_pet();
      return "OK: switched to pet";
    }
    return "ERR: usage: screen [settings|apps|pet]";
  }

  return "ERR: unknown command '" + verb + "'. type 'help'";
}

// ==================== JSON 指令解析 ====================
String handleJson(const String& json_str) {
  JsonDocument doc;
  DeserializationError err = deserializeJson(doc, json_str);
  if (err) {
    return "{\"error\":\"JSON parse error: " + String(err.c_str()) + "\"}";
  }

  const char* type = doc["type"];

  // ---- 状态同步 ----
  if (strcmp(type, "state_sync") == 0) {
    JsonObject agent = doc["agent"];
    if (!agent.isNull()) {
      const char* agent_type = agent["type"];
      if (agent_type) {
        if (strcmp(agent_type, "claude") == 0)
          setAgentType(AgentType::CLAUDE, "Claude");
        else if (strcmp(agent_type, "codex") == 0)
          setAgentType(AgentType::CODEX, "Codex");
        else
          setAgentType(AgentType::OTHER, agent_type);
      }

      const char* state_str = agent["state"];
      if (state_str) {
        setPetStateFromName(String(state_str));
      }

      // 额度更新
      QuotaState q;
      q.total_quota     = agent["quota_total"] | q.total_quota;
      q.used_quota      = agent["quota_used"] | q.used_quota;
      q.h5_total        = agent["quota_h5_total"] | q.h5_total;
      q.h5_used         = agent["quota_h5_used"] | q.h5_used;
      q.h5_remaining    = agent["quota_h5_remaining"] | q.h5_remaining;
      updateQuota(q);

      int32_t refresh = agent["quota_refresh_sec"] | -1;
      if (refresh >= 0) setRefreshCountdown(refresh);
    }

    // 宠物消息
    const char* msg = doc["pet"]["message"];
    if (msg && strlen(msg) > 0) {
      state.pet_message = String(msg);
      state.msg_timestamp = millis();
    }

    return "{\"status\":\"ok\"}";
  }

  // ---- 审批请求 ----
  if (strcmp(type, "approval_request") == 0) {
    ApprovalRequest req;
    req.id             = doc["id"] | "";
    req.agent_type     = doc["agent"] | "";
    req.title          = doc["title"] | "";
    req.description    = doc["description"] | "";
    req.confirm_text   = doc["confirm_text"] | "确认";
    req.reject_text    = doc["reject_text"] | "拒绝";
    req.timeout_s      = doc["timeout"] | APPROVAL_TIMEOUT_S;
    setApprovalRequest(req);

    // 自动弹出审批对话框
    ui::ui_show_approval(
      req.title.c_str(), req.description.c_str(),
      req.confirm_text.c_str(), req.reject_text.c_str(),
      // 确认回调
      []() {
        if (state.approval.active) {
          String response = "{\"type\":\"approval_response\",\"id\":\"" +
            state.approval.id + "\",\"result\":\"approved\"}";
          comm::comm_broadcast(response);
          Serial.printf("[approval] confirmed: %s\n", state.approval.id.c_str());
          clearApproval();
        }
      },
      // 拒绝回调
      []() {
        if (state.approval.active) {
          String response = "{\"type\":\"approval_response\",\"id\":\"" +
            state.approval.id + "\",\"result\":\"rejected\"}";
          comm::comm_broadcast(response);
          Serial.printf("[approval] rejected: %s\n", state.approval.id.c_str());
          clearApproval();
        }
      }
    );

    return "{\"status\":\"approval_received\",\"id\":\"" + req.id + "\"}";
  }

  return "{\"error\":\"unknown type\"}";
}

String getHelp() {
  return s_help_text;
}

} // namespace cmd
