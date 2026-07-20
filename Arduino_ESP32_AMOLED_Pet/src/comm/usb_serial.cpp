/*
 * ============================================================
 *  comm/usb_serial.cpp — USB 串口通信实现
 * ============================================================
 */
#include "comm/usb_serial.h"
#include "command.h"
#include "state.h"
#include <Arduino.h>

namespace comm {

static String s_line_buf;

void usb_begin() {
  // Serial is initialized once at the start of setup(). Reinitializing native
  // USB CDC here can stall immediately after flashing while the host reopens it.
  conn.usb = true;
  state.usb_connected = true;
}

void usb_loop() {
  // Keep USB input from monopolizing the main loop if flashing/monitoring leaves
  // bytes queued. Animation and touch must get CPU time on every loop pass.
  uint16_t budget = 64;
  while (budget-- > 0 && Serial.available()) {
    int ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
s_line_buf.trim();
	      if (s_line_buf.length() > 0) {
	        // 路由到 command parser
	        String resp = cmd::handleText(s_line_buf);
	        if (resp.length() > 0) {
	          Serial.println(resp);
	        }
	      }
      s_line_buf = "";
    } else {
      if (s_line_buf.length() < 200) s_line_buf += (char)ch;
    }
  }
}

void usb_send(const String& data) {
  Serial.println(data);
}

} // namespace comm
