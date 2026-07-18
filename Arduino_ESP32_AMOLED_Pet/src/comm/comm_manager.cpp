/*
 * ============================================================
 *  comm/comm_manager.cpp — 通信多路管理器实现
 * ============================================================
 */
#include "comm/comm_manager.h"
#include "comm/usb_serial.h"
#include "comm/wifi_manager.h"
#include "comm/ble_server.h"
#include "comm/http_api.h"
#include "comm/udp_server.h"
#include "state.h"
#include "command.h"

namespace comm {

void comm_begin() {
  usb_begin();
  wifi_begin();

  // STA 模式启动 HTTP API
  if (wifi_is_sta()) {
    http_begin();
    udp_begin();
  }

  ble_begin();
}

void comm_loop() {
  usb_loop();
  wifi_loop();
  http_loop();
  udp_loop();
  ble_loop();
}

void comm_broadcast(const String& data) {
  usb_send(data);
  if (ble_is_connected()) ble_send(data);
}

} // namespace comm
