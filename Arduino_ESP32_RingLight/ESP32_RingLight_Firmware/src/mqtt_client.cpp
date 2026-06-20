/*
 * ============================================================
 *  mqtt_client.cpp — MQTT 客户端 + Home Assistant 自动发现
 *
 *  订阅:
 *    <topic>/color/set       JSON {"r","g","b"}
 *    <topic>/effect/set      JSON {"effect","r","g","b",...}
 *    <topic>/brightness/set  "128" 或 {"value":128}
 *    <topic>/speed/set       "200" 或 {"value":200}
 *    <topic>/cmd             纯文本 (与串口同格式, 灵活直发)
 *  发布:
 *    <topic>/status          状态 JSON
 *
 *  HA Discovery: homeassistant/light/<node>/light/config
 * ============================================================
 */
#include "mqtt_client.h"
#include "config.h"
#include "state.h"
#include "command.h"
#include "storage.h"
#include <WiFiClient.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>

namespace mqttClient {

static WiFiClient   netClient;
static PubSubClient mqtt(netClient);
static MqttCfg      cfg;
static String       topicBase;     // e.g. "ring"
static unsigned long sLastReconn = 0;
static bool         sDiscoveryPublished = false;

// 构造主题字符串
static String t(const char* suffix) { return topicBase + "/" + suffix; }

bool isEnabled() { return cfg.enabled && cfg.host.length() > 0; }
bool isConnected() { return mqtt.connected(); }

void publishStatus() {
  if (!mqtt.connected()) return;
  String s = getStateJson();
  mqtt.publish(t("status").c_str(), s.c_str(), true);
}

// ---------- Home Assistant 自动发现 ----------
static void publishDiscovery() {
  if (sDiscoveryPublished) return;
  JsonDocument doc;
  doc["name"]         = "ESP32 Ring Light";
  doc["uniq_id"]      = "esp32_ring_light";
  doc["schema"]       = "json";
  doc["state_topic"]  = t("status");
  doc["command_topic"]= t("effect/set");
  doc["brightness"]   = true;
  doc["color_mode"]   = true;
  doc["supported_color_modes"] = "rgb";
  // 效果列表
  JsonArray fx = doc["effect_list"].to<JsonArray>();
  for (uint8_t i = 0; i < EFX_COUNT; i++) fx.add(effectName((EffectType)i));
  doc["effect_command_topic"]   = t("effect/set");
  doc["brightness_command_topic"]= t("brightness/set");
  doc["brightness_state_topic"] = t("status");
  doc["brightness_value_template"] = "{{ value_json.led.brightness }}";
  doc["json_attributes_topic"]  = t("status");

  String confTopic = String(HA_DISCOVERY_PREFIX) + "/light/" +
                     HA_NODE_ID + "/config";
  String payload;
  serializeJson(doc, payload);
  mqtt.publish(confTopic.c_str(), payload.c_str(), true);
  sDiscoveryPublished = true;
  Serial.println(F("[mqtt] HA discovery published"));
}

// ---------- 回调 ----------
static void onMessage(char* topic, byte* payload, unsigned int len) {
  payload[len] = '\0';
  String body = String((const char*)payload);
  String tp   = String(topic);

  if (tp == t("cmd")) {
    cmd::handleText(body);
  } else if (tp == t("color/set")) {
    cmd::handleColorJson(body);
  } else if (tp == t("effect/set")) {
    // HA 发的可能不含 effect, 兼容处理
    if (body.charAt(0) == '{') {
      JsonDocument d;
      if (!deserializeJson(d, body) && d["effect"].is<const char*>()) {
        cmd::handleEffectJson(body);
      } else if (d["r"].is<int>() || d["g"].is<int>() || d["b"].is<int>()) {
        // 只有颜色没有 effect
        cmd::handleColorJson(body);
      }
    }
  } else if (tp == t("brightness/set")) {
    if (body.charAt(0) == '{') cmd::handleBrightnessJson(body);
    else                       cmd::handleText("brightness " + body);
  } else if (tp == t("speed/set")) {
    if (body.charAt(0) == '{') cmd::handleSpeedJson(body);
    else                       cmd::handleText("speed " + body);
  }
  publishStatus();
}

void begin() {
  cfg = storage::loadMqtt();
  if (!isEnabled()) {
    Serial.println(F("[mqtt] disabled"));
    return;
  }
  topicBase = (cfg.topic.length() > 0) ? cfg.topic : MQTT_DEFAULT_TOPIC;
  mqtt.setBufferSize(768);
  mqtt.setServer(cfg.host.c_str(), cfg.port);
  if (cfg.user.length() > 0) {
    // 带用户名密码连接在 loop 里处理
  }
  mqtt.setKeepAlive(30);
  mqtt.setCallback(onMessage);
  Serial.print(F("[mqtt] cfg ")); Serial.print(cfg.host);
  Serial.print(F(":")); Serial.println(cfg.port);
}

static void doConnect() {
  bool ok;
  if (cfg.user.length() > 0) {
    ok = mqtt.connect(FW_NAME, cfg.user.c_str(), cfg.pass.c_str());
  } else {
    ok = mqtt.connect(FW_NAME);
  }
  if (ok) {
    Serial.println(F("[mqtt] connected"));
    // 订阅
    mqtt.subscribe(t("cmd").c_str());
    mqtt.subscribe(t("color/set").c_str());
    mqtt.subscribe(t("effect/set").c_str());
    mqtt.subscribe(t("brightness/set").c_str());
    mqtt.subscribe(t("speed/set").c_str());
    sDiscoveryPublished = false;
    publishDiscovery();
    publishStatus();
    conn.mqtt = true;
  } else {
    Serial.print(F("[mqtt] connect failed, state=")); Serial.println(mqtt.state());
    conn.mqtt = false;
  }
}

void loop() {
  if (!isEnabled()) { conn.mqtt = false; return; }
  if (!mqtt.loop()) {
    // 断线, 5 秒重连一次
    unsigned long now = millis();
    if (now - sLastReconn >= 5000UL) {
      sLastReconn = now;
      doConnect();
    }
  } else if (!mqtt.connected()) {
    doConnect();
  }
}

} // namespace mqttClient
