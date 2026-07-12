/*
 * ============================================================
 *  comm/http_api.cpp — HTTP REST API 实现
 *  提供 GET /state, POST /cmd 等接口
 * ============================================================
 */
#include "comm/http_api.h"
#include "comm/wifi_manager.h"
#include "state.h"
#include "command.h"
#include <Arduino.h>
#include <WebServer.h>

namespace comm {

static WebServer* s_server = nullptr;

static void handle_state() {
  s_server->sendHeader("Cache-Control", "no-store");
  s_server->send(200, "application/json", getStateJson());
}

static void handle_cmd() {
  if (s_server->hasArg("plain")) {
    String body = s_server->arg("plain");
    String resp = cmd::handleJson(body);
    s_server->send(200, "application/json", resp);
  } else {
    s_server->send(400, "application/json", "{\"error\":\"no body\"}");
  }
}

static void handle_text_cmd() {
  if (s_server->hasArg("cmd")) {
    String cmd_text = s_server->arg("cmd");
    String resp = cmd::handleText(cmd_text);
    s_server->send(200, "text/plain", resp);
  } else {
    s_server->send(400, "text/plain", "missing 'cmd' param");
  }
}

static void handle_not_found() {
  s_server->send(404, "text/plain", "404");
}

void http_begin() {
  if (!comm::wifi_is_sta()) return;

  s_server = new WebServer(HTTP_PORT);

  s_server->on("/", HTTP_GET, handle_state);
  s_server->on("/api/state", HTTP_GET, handle_state);
  s_server->on("/api/cmd", HTTP_POST, handle_cmd);
  s_server->on("/api/cmd", HTTP_GET, handle_text_cmd);
  s_server->onNotFound(handle_not_found);

  s_server->begin();
  Serial.print(F("[http] API server started on http://"));
  Serial.print(comm::wifi_ip());
  Serial.print(F(":"));
  Serial.println(HTTP_PORT);
}

void http_loop() {
  if (s_server) s_server->handleClient();
}

} // namespace comm