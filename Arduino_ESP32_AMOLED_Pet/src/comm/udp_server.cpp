#include "comm/udp_server.h"

#include "command.h"
#include "comm/wifi_manager.h"
#include "pin_config.h"
#include "state.h"

#include <Arduino.h>
#include <ArduinoJson.h>
#include <WiFi.h>
#include <WiFiUdp.h>

namespace comm {

static WiFiUDP s_udp;
static bool s_started = false;

static String discovery_json() {
  JsonDocument doc;
  doc["id"] = String("agentaura-") + WiFi.macAddress();
  doc["mac"] = WiFi.macAddress();
  doc["device"] = FW_NAME;
  doc["model"] = DEVICE_MODEL;
  doc["fw"] = FW_VERSION;
  doc["ip"] = wifi_ip();
  doc["udp"] = UDP_PORT;
  doc["http"] = HTTP_PORT;
  doc["effect"] = getPetStateString(state.pet_state);
  JsonArray caps = doc["caps"].to<JsonArray>();
  caps.add("legacy-http");
  caps.add("legacy-udp");
  caps.add("agent-v1");
  caps.add("pet-message");

  String output;
  serializeJson(doc, output);
  return output;
}

void udp_begin() {
  if (s_started || !wifi_is_sta()) return;
  s_started = s_udp.begin(UDP_PORT) == 1;
  conn.udp = s_started;
  if (s_started) {
    Serial.printf("[udp] command/discovery server started on port %u\n", UDP_PORT);
  } else {
    Serial.printf("[udp] failed to bind port %u\n", UDP_PORT);
  }
}

void udp_loop() {
  if (!s_started) return;

  int packet_size = s_udp.parsePacket();
  if (packet_size <= 0) return;

  char buffer[CMD_BUF_SIZE + 1];
  int size = s_udp.read(buffer, CMD_BUF_SIZE);
  if (size < 0) size = 0;
  buffer[size] = '\0';

  String request(buffer);
  request.trim();
  String lower = request;
  lower.toLowerCase();

  String response;
  if (lower == "discover" || lower == "ping" || lower == "who") {
    response = discovery_json();
  } else if (lower == "state") {
    response = getStateJson();
  } else {
    response = cmd::handleText(request);
  }

  s_udp.beginPacket(s_udp.remoteIP(), s_udp.remotePort());
  s_udp.write(reinterpret_cast<const uint8_t*>(response.c_str()), response.length());
  s_udp.endPacket();
}

} // namespace comm
