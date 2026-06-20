/*
 * ============================================================
 *  http_api.cpp — REST API + 控制面板 + WLED 兼容
 *  仅在 STA 连接成功时由 main 启用
 * ============================================================
 */
#include "http_api.h"
#include "config.h"
#include "state.h"
#include "command.h"
#include "storage.h"
#include "network.h"
#include "web/index_html.h"
#include <WebServer.h>

namespace httpApi {

static WebServer server(HTTP_PORT);

static void sendState() {
  server.sendHeader("Cache-Control", "no-store");
  server.send(200, "application/json", getStateJson());
}

// 读取 POST body
static String body() {
  if (server.hasArg("plain")) return server.arg("plain");
  // 也兼容表单参数
  String s;
  for (uint8_t i = 0; i < server.args(); i++) {
    if (i) s += "&";
    s += server.argName(i); s += "="; s += server.arg(i);
  }
  return s;
}

static void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", INDEX_HTML);
}

static void handleCmd() {
  // 通用文本指令 POST /api/cmd, body = 文本指令
  String line = body();
  line.trim();
  if (line.length() == 0) { server.send(400, "text/plain", "empty"); return; }
  String resp = cmd::handleText(line);
  server.send(200, "text/plain", resp);
}

static void handleColor() {
  // 优先 JSON body
  String b = body();
  if (b.length() > 0 && b.charAt(0) == '{') {
    server.send(200, "text/plain", cmd::handleColorJson(b));
  } else if (server.hasArg("r") && server.hasArg("g") && server.hasArg("b")) {
    String t = "rgb " + server.arg("r") + "," + server.arg("g") + "," + server.arg("b");
    server.send(200, "text/plain", cmd::handleText(t));
  } else {
    server.send(400, "text/plain", "need r,g,b");
  }
}

static void handleEffect() {
  String b = body();
  if (b.length() > 0 && b.charAt(0) == '{') {
    server.send(200, "text/plain", cmd::handleEffectJson(b));
  } else if (server.hasArg("effect")) {
    String t = "effect " + server.arg("effect");
    server.send(200, "text/plain", cmd::handleText(t));
  } else {
    server.send(400, "text/plain", "need effect");
  }
}

static void handleBrightness() {
  String b = body();
  if (b.length() > 0 && b.charAt(0) == '{') {
    server.send(200, "text/plain", cmd::handleBrightnessJson(b));
  } else if (server.hasArg("value")) {
    server.send(200, "text/plain", cmd::handleText("brightness " + server.arg("value")));
  } else {
    server.send(400, "text/plain", "need value");
  }
}

static void handleSpeed() {
  String b = body();
  if (b.length() > 0 && b.charAt(0) == '{') {
    server.send(200, "text/plain", cmd::handleSpeedJson(b));
  } else if (server.hasArg("value")) {
    server.send(200, "text/plain", cmd::handleText("speed " + server.arg("value")));
  } else {
    server.send(400, "text/plain", "need value");
  }
}

static void handleAgent() {
  if (server.hasArg("state")) {
    server.send(200, "text/plain", cmd::handleText("agent " + server.arg("state")));
  } else {
    server.send(400, "text/plain", "need state");
  }
}

// WLED 兼容: /win&R=..&G=..&B=..&A=亮度&FX=效果编号&T=速度
// 路径写成 /win 形式, 参数在 query
static void handleWin() {
  if (server.hasArg("R") || server.hasArg("G") || server.hasArg("B")) {
    String r = server.arg("R"); String g = server.arg("G"); String b = server.arg("B");
    cmd::handleText("rgb " + r + "," + g + "," + b);
  }
  if (server.hasArg("A")) {   // A = 亮度 0-255
    cmd::handleText("brightness " + server.arg("A"));
  }
  if (server.hasArg("T")) {   // T = 速度 0-255
    cmd::handleText("speed " + server.arg("T"));
  }
  if (server.hasArg("FX")) {  // FX = 效果编号 (0-14 对应我们的枚举)
    int fx = server.arg("FX").toInt();
    if (fx >= 0 && fx < EFX_COUNT) {
      cmd::handleText(String("effect ") + effectName((EffectType)fx));
    }
  }
  sendState();
}

static void handleReset() {
  cmd::handleText("reset");
  server.send(200, "text/plain", "OK reset");
}

// 配置页 (STA 模式下也可修改 WiFi/MQTT)
static void handleConfig() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", CONFIG_HTML);
}

static void handleConfigSave() {
  String ssid = server.arg("ssid");
  String pass = server.arg("pass");
  bool   mqen = server.hasArg("mqen");
  String mhost= server.arg("mhost");
  String mport= server.arg("mport");
  String muser= server.arg("muser");
  String mpass= server.arg("mpass");
  String mtopic=server.arg("mtopic");

  storage::saveWifi(ssid, pass);
  if (mqen && mhost.length() > 0) {
    MqttCfg m;
    m.host = mhost;
    m.port = (uint16_t)mport.toInt();
    if (m.port == 0) m.port = MQTT_PORT;
    m.user = muser; m.pass = mpass; m.enabled = true;
    m.topic = (mtopic.length() > 0) ? mtopic : MQTT_DEFAULT_TOPIC;
    storage::saveMqtt(m);
  } else {
    storage::clearMqtt();
  }
  server.send(200, "text/html",
    "<html><body style='font-family:sans-serif;padding:20px;background:#0f172a;color:#0ea5e9'>"
    "<h2>已保存, 3 秒后重启...</h2></body></html>");
  net::requestRestart();
}

static void handleNotFound() {
  server.send(404, "text/plain", "404 Not Found");
}

void begin() {
  server.on("/",              HTTP_GET,  handleRoot);
  server.on("/api/state",     HTTP_GET,  sendState);
  server.on("/api/cmd",       HTTP_POST, handleCmd);
  server.on("/api/color",     HTTP_POST, handleColor);
  server.on("/api/effect",    HTTP_POST, handleEffect);
  server.on("/api/brightness",HTTP_POST, handleBrightness);
  server.on("/api/speed",     HTTP_POST, handleSpeed);
  server.on("/api/agent",     HTTP_ANY,  handleAgent);
  server.on("/reset",         HTTP_GET,  handleReset);
  server.on("/config",        HTTP_GET,  handleConfig);
  server.on("/save",          HTTP_POST, handleConfigSave);
  // WLED 兼容: 路径含 &, 用 onNotFound 捕获
  server.onNotFound([&]() {
    String uri = server.uri();
    if (uri.startsWith("/win")) { handleWin(); return; }
    handleNotFound();
  });
  server.begin();
  Serial.println(F("[http] REST API started on :80"));
}

void loop() {
  server.handleClient();
}

} // namespace httpApi
