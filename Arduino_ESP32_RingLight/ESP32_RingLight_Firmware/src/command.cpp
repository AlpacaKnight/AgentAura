/*
 * ============================================================
 *  command.cpp — 统一指令解析器
 *  支持: rgb / effect NAME [params] / brightness N / speed N
 *        / state / reset / wifi SSID,PASS / power on|off
 *        / agent STATE   (智能体状态映射 §5)
 *
 *  JSON 入口 (color/effect/brightness/speed) 供 HTTP/MQTT 使用.
 * ============================================================
 */
#include "command.h"
#include "config.h"
#include "state.h"
#include "effects.h"
#include "storage.h"
#include "network.h"
#include "led_driver.h"
#include <ArduinoJson.h>

namespace cmd {

// ---------- 智能体状态预设 (§5) ----------
// offline 特殊: 关灯 (power=false), 不使用 effect
// speed:    0xFF = 不强制 (沿用当前 state.speed); 否则强制设定该速度
// autoOffMs: 0 = 不自动关灯; >0 = 显示该毫秒后无新指令则自动关灯
struct AgentPreset {
  const char* name; EffectType e;
  uint8_t r, g, b; bool powerOff;
  uint8_t speed; unsigned long autoOffMs;
};
static const AgentPreset kAgentPresets[] = {
  {"running",   EFX_BREATH,   0,   255, 0,   false, 0xFF, 0},               // 正常运行
  {"busy",      EFX_FLOW,     255, 200, 0,   false, 0xFF, 0},               // 忙碌/处理中
  {"processing",EFX_FLOW,     255, 200, 0,   false, 0xFF, 0},               // 同 busy 别名
  {"waiting",   EFX_BLINK,    255, 200, 0,   false, 0xFF, 0},               // 等待审批
  {"error",     EFX_BLINK,    255, 0,   0,   false, 0xFF, 0},               // 错误/异常
  {"idle",      EFX_BREATH,   0,   100, 255, false, 230,  IDLE_AUTO_OFF_MS},// 空闲: 快速丝滑呼吸, 5s 自动关灯
  {"init",      EFX_RAINBOW,  0,   0,   0,   false, 0xFF, INIT_AUTO_OFF_MS},// 初始化中: 彩虹 3s 自动关灯
  {"offline",   EFX_SOLID,    0,   0,   0,   true,  0xFF, 0},               // 离线: 关灯
  {"standby",   EFX_SOLID,    0,   0,   0,   true,  0xFF, 0},               // 同 offline 别名
  {"upgrade",   EFX_METEOR,   255, 165, 0,   false, 0xFF, 0},               // 升级中
  {"updating",  EFX_METEOR,   255, 165, 0,   false, 0xFF, 0},
};

// 启动动画后 power=false (关灯等待命令); 收到设置灯效/颜色指令时唤醒
static void wakeIfNeeded() {
  if (!state.power) state.power = true;
}

// applyAndSave 是所有"设置类"指令 (rgb/effect/brightness/speed/power
// 以及 JSON 入口) 的公共收尾. 任何这类指令都应取消 agent init 挂起的
// 自动关灯, 让新指令立即生效.
// 例外: handleAgentState("init") 需要在 applyAndSave 之后再 scheduleAutoOff,
// 因此 applyAndSave 在这里无条件 cancel, 由 init 调用方随后重新安排.
void applyAndSave();

bool handleAgentState(const String& stateName) {
  String n = stateName;
  n.trim();
  for (auto& c : n) if (c >= 'A' && c <= 'Z') c = char(c + ('a' - 'A'));
  for (const auto& p : kAgentPresets) {
    if (n == p.name) {
      if (p.powerOff) {
        // offline/standby: 关灯
        setPower(false);
      } else {
        // 某些状态 (idle) 强制一个专用 speed, 让呼吸更快速丝滑
        if (p.speed != 0xFF) setCurrentSpeed(p.speed);
        setCurrentColor(p.r, p.g, p.b);
        setCurrentEffect(p.e);
        wakeIfNeeded();
      }
      applyAndSave();   // 内部会 cancelAutoOff()
      // 部分状态 (init/idle) 显示固定时长后自动关灯 (若期间无新指令)
      if (!p.powerOff && p.autoOffMs > 0) {
        scheduleAutoOff(p.autoOffMs);
      }
      return true;
    }
  }
  return false;
}

void applyAndSave() {
  // 收到任何设置类指令都取消挂起的自动关灯, 新指令立即接管
  cancelAutoOff();
  ledDriver::showFrame();
  storage::saveSettings();
}

// ---------- 工具: 解析 "R,G,B" 三元组 ----------
static bool parseRgb(const String& s, uint8_t& r, uint8_t& g, uint8_t& b) {
  int c1 = s.indexOf(',');
  if (c1 < 0) return false;
  int c2 = s.indexOf(',', c1 + 1);
  if (c2 < 0) return false;
  r = (uint8_t)constrain(s.substring(0, c1).toInt(), 0, 255);
  g = (uint8_t)constrain(s.substring(c1 + 1, c2).toInt(), 0, 255);
  b = (uint8_t)constrain(s.substring(c2 + 1).toInt(), 0, 255);
  return true;
}

// 解析 "R,G,B" 或 "R1,G1,B1,R2,G2,B2"
static bool parseRgb12(const String& s,
                       uint8_t& r1, uint8_t& g1, uint8_t& b1,
                       uint8_t& r2, uint8_t& g2, uint8_t& b2,
                       bool& hasSecond) {
  int commas = 0;
  for (char c : s) if (c == ',') commas++;
  if (commas == 2) {
    hasSecond = false;
    return parseRgb(s, r1, g1, b1);
  }
  if (commas == 5) {
    int c1 = s.indexOf(',');
    int c2 = s.indexOf(',', c1 + 1);
    int c3 = s.indexOf(',', c2 + 1);
    int c4 = s.indexOf(',', c3 + 1);
    int c5 = s.indexOf(',', c4 + 1);
    r1 = (uint8_t)constrain(s.substring(0, c1).toInt(), 0, 255);
    g1 = (uint8_t)constrain(s.substring(c1 + 1, c2).toInt(), 0, 255);
    b1 = (uint8_t)constrain(s.substring(c2 + 1, c3).toInt(), 0, 255);
    r2 = (uint8_t)constrain(s.substring(c3 + 1, c4).toInt(), 0, 255);
    g2 = (uint8_t)constrain(s.substring(c4 + 1, c5).toInt(), 0, 255);
    b2 = (uint8_t)constrain(s.substring(c5 + 1).toInt(), 0, 255);
    hasSecond = true;
    return true;
  }
  return false;
}

static uint8_t parseSpeedTok(const String& s) {
  // 在 "R,G,B,Speed" 中取最后一项作 speed
  int last = s.lastIndexOf(',');
  if (last < 0) return DEFAULT_SPEED;
  int v = s.substring(last + 1).toInt();
  return (uint8_t)constrain(v, 0, 255);
}

// ============================================================
//                       文本指令解析
// ============================================================
String handleText(const String& rawLine) {
  String line = rawLine;
  line.trim();
  if (line.length() == 0) return "";

  // 取第一个 token
  int sp = line.indexOf(' ');
  String head = (sp < 0) ? line : line.substring(0, sp);
  String rest = (sp < 0) ? String("") : line.substring(sp + 1);
  rest.trim();
  for (auto& c : head) if (c >= 'A' && c <= 'Z') c = char(c + ('a' - 'A'));

  if (head == "rgb" || head == "color") {
    uint8_t r, g, b;
    if (!parseRgb(rest, r, g, b)) return F("ERR rgb R,G,B");
    setCurrentColor(r, g, b);
    if (state.effect != EFX_SOLID && state.effect != EFX_BREATH &&
        state.effect != EFX_BLINK && state.effect != EFX_PULSE) {
      setCurrentEffect(EFX_SOLID);
    }
    wakeIfNeeded();
    applyAndSave();
    return F("OK rgb");
  }

  if (head == "effect") {
    // effect NAME [params]
    int p = rest.indexOf(' ');
    String efxName = (p < 0) ? rest : rest.substring(0, p);
    String params  = (p < 0) ? String("") : rest.substring(p + 1);
    params.trim();
    EffectType e = effectFromName(efxName);
    if (e == EFX_INVALID) return String("ERR unknown effect: ") + efxName;

    // 按效果类型解析参数
    if (params.length() > 0) {
      uint8_t r1, g1, b1, r2, g2, b2; bool has2;
      bool needColor = (e == EFX_SOLID || e == EFX_BREATH || e == EFX_FLOW ||
                        e == EFX_BLINK || e == EFX_SPARKLE || e == EFX_METEOR ||
                        e == EFX_BOUNCE || e == EFX_PULSE || e == EFX_FADE);
      bool needTwo   = (e == EFX_GRADIENT || e == EFX_WAVE);
      bool needSpeed = (e == EFX_FLOW || e == EFX_RAINBOW || e == EFX_BLINK ||
                        e == EFX_FIRE || e == EFX_SPARKLE || e == EFX_CYCLE ||
                        e == EFX_METEOR || e == EFX_BOUNCE || e == EFX_FADE ||
                        e == EFX_RANDOM);
      if (needTwo) {
        if (parseRgb12(params, r1, g1, b1, r2, g2, b2, has2)) {
          setCurrentColor(r1, g1, b1);
          if (has2) setCurrentColor2(r2, g2, b2);
        }
      } else if (needColor) {
        // 可能是 "R,G,B" 或 "R,G,B,Speed"
        int commas = 0;
        for (char c : params) if (c == ',') commas++;
        if (commas >= 2) {
          if (parseRgb(params, r1, g1, b1)) setCurrentColor(r1, g1, b1);
          if (needSpeed && commas >= 3) setCurrentSpeed(parseSpeedTok(params));
        }
      } else if (needSpeed) {
        int v = params.toInt();
        setCurrentSpeed((uint8_t)constrain(v, 0, 255));
      }
    }
    setCurrentEffect(e);
    wakeIfNeeded();
    applyAndSave();
    return String("OK effect ") + effectName(e);
  }

  if (head == "brightness" || head == "brt") {
    int v = rest.toInt();
    setCurrentBrightness((uint8_t)constrain(v, 0, 255));
    wakeIfNeeded();
    applyAndSave();
    return F("OK brightness");
  }

  if (head == "speed" || head == "spd") {
    int v = rest.toInt();
    setCurrentSpeed((uint8_t)constrain(v, 0, 255));
    applyAndSave();
    return F("OK speed");
  }

  if (head == "power") {
    setPower(rest == "1" || rest == "on" || rest == "true");
    applyAndSave();
    return F("OK power");
  }

  if (head == "state" || head == "?") {
    return getStateJson();
  }

  if (head == "reset") {
    storage::reset();
    setCurrentEffect(state.effect);
    setCurrentColor(state.color1.r, state.color1.g, state.color1.b);
    setCurrentColor2(state.color2.r, state.color2.g, state.color2.b);
    setCurrentBrightness(state.brightness);
    setCurrentSpeed(state.speed);
    setPower(state.power);
    applyAndSave();
    return F("OK reset");
  }

  if (head == "factory") {
    storage::factoryReset();
    ESP.restart();
    return F("OK factory reset");
  }

  if (head == "wifi") {
    int c = rest.indexOf(',');
    if (c < 0) return F("ERR wifi SSID,PASSWORD");
    String ssid = rest.substring(0, c);
    String pass = rest.substring(c + 1);
    storage::saveWifi(ssid, pass);
    return F("OK wifi saved, restarting...");
  }

  if (head == "agent") {
    if (handleAgentState(rest)) return String("OK agent ") + rest;
    return String("ERR unknown agent state: ") + rest;
  }

  if (head == "help" || head == "?") {
    return F("cmds: rgb R,G,B | effect NAME [params] | brightness N | "
             "speed N | power on|off | state | reset | factory | "
             "wifi SSID,PASS | agent STATE | help");
  }

  return String("ERR unknown cmd: ") + head;
}

// ============================================================
//                       JSON 入口
// ============================================================
String handleColorJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return F("ERR bad json");
  uint8_t r = doc["r"] | state.color1.r;
  uint8_t g = doc["g"] | state.color1.g;
  uint8_t b = doc["b"] | state.color1.b;
  setCurrentColor(r, g, b);
  if (state.effect != EFX_SOLID && state.effect != EFX_BREATH &&
      state.effect != EFX_BLINK && state.effect != EFX_PULSE) {
    setCurrentEffect(EFX_SOLID);
  }
  applyAndSave();
  return F("OK");
}

String handleEffectJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return F("ERR bad json");
  String name = doc["effect"] | "solid";
  EffectType e = effectFromName(name);
  if (e == EFX_INVALID) return String("ERR unknown effect: ") + name;
  uint8_t r = doc["r"] | state.color1.r;
  uint8_t g = doc["g"] | state.color1.g;
  uint8_t b = doc["b"] | state.color1.b;
  setCurrentColor(r, g, b);
  if (doc["r2"].is<int>() || doc["g2"].is<int>() || doc["b2"].is<int>()) {
    setCurrentColor2(doc["r2"] | 0, doc["g2"] | 0, doc["b2"] | 255);
  }
  if (doc["speed"].is<int>()) setCurrentSpeed(doc["speed"].as<int>());
  if (doc["brightness"].is<int>()) setCurrentBrightness(doc["brightness"].as<int>());
  setCurrentEffect(e);
  applyAndSave();
  return F("OK");
}

String handleBrightnessJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return F("ERR bad json");
  int v = doc["value"] | state.brightness;
  setCurrentBrightness((uint8_t)constrain(v, 0, 255));
  applyAndSave();
  return F("OK");
}

String handleSpeedJson(const String& payload) {
  JsonDocument doc;
  if (deserializeJson(doc, payload)) return F("ERR bad json");
  int v = doc["value"] | state.speed;
  setCurrentSpeed((uint8_t)constrain(v, 0, 255));
  applyAndSave();
  return F("OK");
}

} // namespace cmd
