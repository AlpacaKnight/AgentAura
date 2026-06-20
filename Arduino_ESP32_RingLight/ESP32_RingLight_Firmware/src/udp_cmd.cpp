/*
 * ============================================================
 *  udp_cmd.cpp — UDP 文本指令 + 局域网广播发现
 *  端口 UDP_PORT (默认 8888)
 *  支持指令 "discover" 回送设备信息 JSON
 * ============================================================
 */
#include "udp_cmd.h"
#include "config.h"
#include "state.h"
#include "command.h"
#include "network.h"
#include <WiFi.h>
#include <WiFiUdp.h>
#include <ArduinoJson.h>

namespace udpCmd {

static WiFiUDP udp;
static char    rxBuf[512];

void begin() {
  if (udp.begin(UDP_PORT)) {
    Serial.print(F("[udp] listening on ")); Serial.println(UDP_PORT);
    conn.udp = true;
  } else {
    Serial.println(F("[udp] begin failed"));
  }
}

void loop() {
  int packetSize = udp.parsePacket();
  if (packetSize <= 0) return;
  int len = udp.read(rxBuf, sizeof(rxBuf) - 1);
  if (len <= 0) return;
  rxBuf[len] = '\0';

  String line = String(rxBuf);
  line.trim();

  // 广播发现: "discover" -> 回送设备信息
  String low = line;
  for (auto& c : low) if (c >= 'A' && c <= 'Z') c = char(c + ('a' - 'A'));
  if (low == "discover" || low == "ping" || low == "who") {
    JsonDocument doc;
    doc["device"]  = FW_NAME;
    doc["model"]   = DEVICE_MODEL;
    doc["fw"]      = FW_VERSION;
    doc["ip"]      = net::ipString();
    doc["mac"]     = WiFi.macAddress();
    doc["udp"]     = UDP_PORT;
    doc["http"]    = HTTP_PORT;
    doc["effect"]  = effectName(state.effect);
    String out;
    serializeJson(doc, out);
    udp.beginPacket(udp.remoteIP(), udp.remotePort());
    udp.write((const uint8_t*)out.c_str(), out.length());
    udp.endPacket();
    return;
  }

  String resp = cmd::handleText(line);
  // 把响应回送给发送方
  if (resp.length() > 0) {
    udp.beginPacket(udp.remoteIP(), udp.remotePort());
    udp.write((const uint8_t*)resp.c_str(), resp.length());
    udp.endPacket();
  }
}

} // namespace udpCmd
