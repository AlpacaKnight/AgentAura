/*
 * ============================================================
 *  network.cpp — WiFi STA/AP 管理 + 配置页 + mDNS + 重连
 * ============================================================
 */
#include "network.h"
#include "config.h"
#include "storage.h"
#include "web/index_html.h"
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <esp_wifi.h>

namespace net {

Mode currentMode = MODE_NONE;
static WebServer* cfgServer = nullptr;
static unsigned long sLastCheck = 0;
static bool sRestartReq = false;
static String sSsid;
static String sApSsid;

static String macSuffix() {
  uint64_t m = ESP.getEfuseMac();
  uint16_t lo = (uint16_t)(m & 0xFFFF);
  char buf[6];
  snprintf(buf, sizeof(buf), "%02X%02X", (lo >> 8) & 0xFF, lo & 0xFF);
  return String(buf);
}

static void startAP() {
  sApSsid = String(AP_SSID_PREFIX) + macSuffix();
  WiFi.mode(WIFI_AP);
  WiFi.softAP(sApSsid.c_str(),
              (AP_PASSWORD[0] != '\0') ? AP_PASSWORD : nullptr,
              AP_CHANNEL);
  currentMode = MODE_AP;
  Serial.println(F("[net] AP mode"));
  Serial.print(F("[net] SSID: "));   Serial.println(sApSsid);
  Serial.print(F("[net] AP IP: "));  Serial.println(WiFi.softAPIP());
}

static void handleCfgRoot() {
  cfgServer->sendHeader("Cache-Control", "no-store");
  cfgServer->send_P(200, "text/html", CONFIG_HTML);
}
static void handleCfgSave() {
  String ssid = cfgServer->arg("ssid");
  String pass = cfgServer->arg("pass");
  bool   mqen = cfgServer->hasArg("mqen");
  String mhost= cfgServer->arg("mhost");
  String mport= cfgServer->arg("mport");
  String muser= cfgServer->arg("muser");
  String mpass= cfgServer->arg("mpass");
  String mtopic=cfgServer->arg("mtopic");

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
  cfgServer->send(200, "text/html",
    "<html><body style='font-family:sans-serif;padding:20px;background:#0f172a;color:#0ea5e9'>"
    "<h2>✅ 已保存, 3 秒后重启...</h2>"
    "<p>请重新连接到新 WiFi 后访问设备.</p></body></html>");
  sRestartReq = true;
}
static void handleCfgNotFound() {
  cfgServer->send(404, "text/plain", "404");
}

void begin() {
  WifiCred w = storage::loadWifi();
  // NVS 无 WiFi 配置时, 使用 config.h 默认 WiFi 尝试连接
  if (!w.valid) {
    w.ssid   = DEFAULT_WIFI_SSID;
    w.pass   = DEFAULT_WIFI_PASS;
    w.valid  = w.ssid.length() > 0;
    Serial.println(F("[net] no saved wifi, using default config"));
  }
  bool staOk = false;
  if (w.valid) {
    WiFi.mode(WIFI_STA);
    WiFi.setHostname(FW_NAME);
    WiFi.begin(w.ssid.c_str(), w.pass.c_str());
    Serial.print(F("[net] STA connecting to ")); Serial.println(w.ssid);
    unsigned long t0 = millis();
    while (WiFi.status() != WL_CONNECTED && millis() - t0 < STA_TIMEOUT_MS) {
      delay(200);
      Serial.print(F("."));
    }
    if (WiFi.status() == WL_CONNECTED) {
      staOk = true;
      sSsid = w.ssid;
      currentMode = MODE_STA;
      Serial.println();
      Serial.print(F("[net] STA IP: ")); Serial.println(WiFi.localIP());
      Serial.print(F("[net] RSSI: "));   Serial.println(WiFi.RSSI());
      // WiFi-BLE 共存: 关闭省电, 让 BLE 有更多射频时间
      esp_wifi_set_ps(WIFI_PS_NONE);
      Serial.println(F("[net] WiFi PS=NONE for BLE coexistence"));
    } else {
      Serial.println(F("\n[net] STA failed"));
    }
  }

  if (!staOk) {
    startAP();
  }

  // mDNS (无论哪种模式都起, 方便 .local 访问)
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    Serial.print(F("[net] mDNS: http://")); Serial.print(MDNS_NAME); Serial.println(F(".local"));
  }

  // AP 模式: 起配置服务器
  if (currentMode == MODE_AP) {
    cfgServer = new WebServer(HTTP_PORT);
    cfgServer->on("/",        HTTP_GET,  handleCfgRoot);
    cfgServer->on("/config",  HTTP_GET,  handleCfgRoot);
    cfgServer->on("/save",    HTTP_POST, handleCfgSave);
    cfgServer->onNotFound(handleCfgNotFound);
    cfgServer->begin();
    Serial.println(F("[net] config server started"));
  }
}

void loop() {
  if (cfgServer) cfgServer->handleClient();
  if (sRestartReq) { delay(300); ESP.restart(); }

  // STA 断线重连
  if (currentMode == MODE_STA) {
    unsigned long now = millis();
    if (now - sLastCheck >= WIFI_RECONN_MS) {
      sLastCheck = now;
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println(F("[net] wifi lost, reconnecting..."));
        WiFi.reconnect();
      }
    }
  }
}

bool isSTA() { return currentMode == MODE_STA && WiFi.status() == WL_CONNECTED; }
bool isAP()  { return currentMode == MODE_AP; }

String ipString() {
  if (currentMode == MODE_STA) return WiFi.localIP().toString();
  if (currentMode == MODE_AP)  return WiFi.softAPIP().toString();
  return "0.0.0.0";
}
String ssidString() {
  if (currentMode == MODE_STA) return sSsid;
  if (currentMode == MODE_AP)  return sApSsid;
  return "";
}
int rssi() {
  if (currentMode == MODE_STA) return WiFi.RSSI();
  return 0;
}

String connectionsJson() {
  String s = "{";
  s += "\"mode\":\""; s += (currentMode == MODE_STA ? "STA" : (currentMode == MODE_AP ? "AP" : "none")); s += "\",";
  s += "\"ip\":\"";   s += ipString(); s += "\",";
  s += "\"ssid\":\""; s += ssidString(); s += "\",";
  s += "\"rssi\":";   s += rssi();
  s += "}";
  return s;
}

void requestRestart() { sRestartReq = true; }

} // namespace net
