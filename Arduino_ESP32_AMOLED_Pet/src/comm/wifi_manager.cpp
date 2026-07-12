/*
 * ============================================================
 *  comm/wifi_manager.cpp — WiFi STA/AP 管理实现
 *  参考环形灯固件 network.cpp 的架构
 * ============================================================
 */
#include "comm/wifi_manager.h"
#include "comm/../storage.h"
#include "pin_config.h"
#include "config.h"
#include "state.h"
#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <esp_wifi.h>

namespace comm {

static WebServer* s_cfg_server = nullptr;
static unsigned long s_last_check = 0;
static bool s_restart_req = false;
static bool s_sta_enabled = true;  // 用户设置

// 配网页 HTML (简化内嵌版)
static const char CONFIG_HTML[] PROGMEM = R"rawliteral(
<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AgentAura 配置</title>
<style>
body{font-family:sans-serif;background:#1a1a2e;color:#e0e0e0;margin:0;padding:20px}
.card{background:#16213e;border-radius:12px;padding:20px;max-width:400px;margin:20px auto}
h2{color:#0ea5e9;margin:0 0 20px}
label{display:block;margin:12px 0 4px;color:#94a3b8}
input,select{width:100%;padding:10px;border:1px solid #334;border-radius:6px;background:#0f172a;color:#e0e0e0;box-sizing:border-box}
button{width:100%;padding:12px;background:#0ea5e9;border:none;border-radius:6px;color:#fff;font-size:16px;cursor:pointer;margin-top:16px}
button:hover{background:#0284c7}
.status{text-align:center;margin-bottom:20px;font-size:14px;color:#94a3b8}
</style></head><body>
<div class="card">
<h2>⚙ AgentAura 配置</h2>
<div class="status">设备: <span id="ip">连接中...</span></div>
<form action="/save" method="POST">
<label>WiFi SSID</label>
<select id="ssid" name="ssid"><option value="">-- 扫描中 --</option></select>
<label>WiFi 密码</label>
<input type="password" name="pass" placeholder="留空=开放">
<label>MQTT 服务器 (可选)</label>
<input type="text" name="mhost" placeholder="192.168.1.100">
<input type="text" name="mport" placeholder="1883" style="margin-top:4px">
<input type="text" name="mtopic" placeholder="agentaura">
<button type="submit">保存并重启</button>
</form></div>
<script>
fetch('/api/scan').then(r=>r.json()).then(d=>{
  const sel=document.getElementById('ssid');
  sel.innerHTML='<option value="">-- 选择 WiFi --</option>';
  d.networks.forEach(n=>{
    const o=document.createElement('option');
    o.value=n.ssid;o.textContent=n.ssid+(n.rssi?' ('+n.rssi+'dBm)':'');
    sel.appendChild(o);
  });
});
document.getElementById('ip').textContent=location.hostname||location.ip||'已连接';
</script></body></html>
)rawliteral";

static String s_ap_ssid;
static String s_current_ssid;

static String mac_suffix() {
  uint64_t m = ESP.getEfuseMac();
  uint16_t lo = (uint16_t)(m & 0xFFFF);
  char buf[6];
  snprintf(buf, sizeof(buf), "%02X%02X", (lo >> 8) & 0xFF, lo & 0xFF);
  return String(buf);
}

static void start_ap() {
  s_ap_ssid = String(AP_SSID_PREFIX) + mac_suffix();
  WiFi.mode(WIFI_AP);
  WiFi.softAP(s_ap_ssid.c_str(),
              (AP_PASSWORD[0] != '\0') ? AP_PASSWORD : nullptr,
              AP_CHANNEL);
  Serial.print(F("[wifi] AP mode: "));
  Serial.println(s_ap_ssid);
  Serial.print(F("[wifi] AP IP: "));
  Serial.println(WiFi.softAPIP());
  state.wifi_connected = false;
}

static void handle_cfg_root() {
  s_cfg_server->sendHeader("Cache-Control", "no-store");
  s_cfg_server->send_P(200, "text/html", CONFIG_HTML);
}

static void handle_cfg_save() {
  String ssid = s_cfg_server->arg("ssid");
  String pass = s_cfg_server->arg("pass");
  String mhost = s_cfg_server->arg("mhost");
  String mport = s_cfg_server->arg("mport");

  if (ssid.length() > 0) {
    // 保存到 NVS
    storage::saveWifi(ssid, pass);
    Serial.printf("[wifi] saved to NVS: %s\n", ssid.c_str());
  }

  // 保存 MQTT 配置
  if (mhost.length() > 0) {
    storage::MqttCfg mqtt;
    mqtt.enabled = true;
    mqtt.host = mhost;
    mqtt.port = (uint16_t)mport.toInt();
    mqtt.topic = "agentaura";
    storage::saveMqtt(mqtt);
    Serial.printf("[wifi] MQTT saved: %s:%d\n", mqtt.host.c_str(), mqtt.port);
  }

  s_cfg_server->send(200, "text/html",
    "<html><body style='font-family:sans-serif;padding:20px;background:#1a1a2e;color:#0ea5e9'>"
    "<h2>✅ 已保存, 3 秒后重启...</h2></body></html>");

  s_restart_req = true;
}

static void handle_api_scan() {
  int n = WiFi.scanComplete();
  String json = "{\"networks\":[";
  for (int i = 0; i < n; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\"";
    json += ",\"rssi\":" + String(WiFi.RSSI(i));
    json += ",\"encrypted\":" + String((WiFi.encryptionType(i) != WIFI_AUTH_OPEN) ? "true" : "false");
    json += "}";
  }
  json += "]}";
  WiFi.scanDelete();
  s_cfg_server->send(200, "application/json", json);
}

static void handle_not_found() {
  s_cfg_server->send(404, "text/plain", "404");
}

void wifi_begin() {
  if (state.wifi_enabled != RadioState::ON) {
    Serial.println(F("[wifi] disabled by user"));
    WiFi.mode(WIFI_OFF);
    state.wifi_connected = false;
    return;
  }

  // 从 NVS 加载保存的凭据
  String sta_ssid = DEFAULT_WIFI_SSID;
  String sta_pass = DEFAULT_WIFI_PASS;
  storage::WifiCred cred = storage::loadWifi();
  if (cred.valid) {
    sta_ssid = cred.ssid;
    sta_pass = cred.pass;
    Serial.printf("[wifi] loaded saved credentials for '%s'\n", sta_ssid.c_str());
  }

  // 尝试 STA
  WiFi.mode(WIFI_STA);
  WiFi.setHostname(MDNS_NAME);
  WiFi.begin(sta_ssid.c_str(), sta_pass.c_str());

  Serial.print(F("[wifi] STA connecting"));
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < STA_TIMEOUT_MS) {
    delay(200);
    Serial.print(F("."));
  }

  if (WiFi.status() == WL_CONNECTED) {
    s_current_ssid = sta_ssid;
    state.wifi_connected = true;
    Serial.println();
    Serial.print(F("[wifi] STA IP: "));
    Serial.println(WiFi.localIP());
    // WiFi-BLE 共存优化
    esp_wifi_set_ps(WIFI_PS_NONE);
  } else {
    Serial.println(F(" FAILED"));
    start_ap();
  }

  // mDNS
  if (MDNS.begin(MDNS_NAME)) {
    MDNS.addService("http", "tcp", HTTP_PORT);
    Serial.print(F("[wifi] mDNS: http://"));
    Serial.print(MDNS_NAME);
    Serial.println(F(".local"));
  }

  // AP 模式: 启动配置服务器(带 WiFi 扫描
  if (wifi_is_ap()) {
    s_cfg_server = new WebServer(HTTP_PORT);
    s_cfg_server->on("/", HTTP_GET, handle_cfg_root);
    s_cfg_server->on("/config", HTTP_GET, handle_cfg_root);
    s_cfg_server->on("/save", HTTP_POST, handle_cfg_save);
    s_cfg_server->on("/api/scan", HTTP_GET, handle_api_scan);
    s_cfg_server->onNotFound(handle_not_found);
    s_cfg_server->begin();
    WiFi.scanNetworks(true);  // 异步扫描
    Serial.println(F("[wifi] config server + scan started"));
  }
}

void wifi_loop() {
  if (s_cfg_server) s_cfg_server->handleClient();
  if (s_restart_req) { delay(300); ESP.restart(); }

  if (wifi_is_sta()) {
    uint32_t now = millis();
    if (now - s_last_check >= WIFI_RECONN_MS) {
      s_last_check = now;
      if (WiFi.status() != WL_CONNECTED) {
        Serial.println(F("[wifi] lost, reconnecting..."));
        WiFi.reconnect();
        state.wifi_connected = false;
      } else {
        state.wifi_connected = true;
      }
    }
  }
}

bool wifi_is_sta() {
  return WiFi.getMode() == WIFI_MODE_STA && WiFi.status() == WL_CONNECTED;
}

bool wifi_is_ap() {
  return WiFi.getMode() == WIFI_MODE_AP;
}

bool wifi_is_connected() {
  return wifi_is_sta() || wifi_is_ap();
}

String wifi_ip() {
  if (wifi_is_sta()) return WiFi.localIP().toString();
  if (wifi_is_ap()) return WiFi.softAPIP().toString();
  return "0.0.0.0";
}

String wifi_ssid() {
  if (wifi_is_sta()) return s_current_ssid;
  if (wifi_is_ap()) return s_ap_ssid;
  return "";
}

int8_t wifi_rssi() {
  if (wifi_is_sta()) return WiFi.RSSI();
  return 0;
}

String wifi_scan_json() {
  int n = WiFi.scanComplete();
  String json = "{\"networks\":[";
  for (int i = 0; i < n && i < WIFI_SCAN_MAX; i++) {
    if (i > 0) json += ",";
    json += "{\"ssid\":\"" + WiFi.SSID(i) + "\"";
    json += ",\"rssi\":" + String(WiFi.RSSI(i));
    json += ",\"encrypted\":" + String((WiFi.encryptionType(i) != WIFI_AUTH_OPEN) ? "true" : "false");
    json += "}";
  }
  json += "]}";
  WiFi.scanDelete();
  return json;
}

String wifi_state_json() {
  String s = "{";
  s += "\"mode\":\""; s += (wifi_is_sta() ? "STA" : (wifi_is_ap() ? "AP" : "off")); s += "\",";
  s += "\"ip\":\"";   s += wifi_ip(); s += "\",";
  s += "\"ssid\":\""; s += wifi_ssid(); s += "\",";
  s += "\"rssi\":";   s += wifi_rssi();
  s += "}";
  return s;
}

void wifi_connect(const String& ssid, const String& pass) {
  s_current_ssid = ssid;
  WiFi.begin(ssid.c_str(), pass.c_str());
  Serial.printf("[wifi] connecting to %s...\n", ssid.c_str());
}

void wifi_disconnect() {
  WiFi.disconnect();
  state.wifi_connected = false;
}

void wifi_toggle(bool on) {
  if (on) {
    state.wifi_enabled = RadioState::ON;
    wifi_begin();
  } else {
    state.wifi_enabled = RadioState::OFF;
    WiFi.mode(WIFI_OFF);
    state.wifi_connected = false;
    if (s_cfg_server) {
      delete s_cfg_server;
      s_cfg_server = nullptr;
    }
  }
}

} // namespace comm