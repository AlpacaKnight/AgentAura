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
  Serial.begin(115200);
  delay(150);
  conn.usb = true;
  state.usb_connected = true;
  Serial.println();
  Serial.println(F("========================================"));
  Serial.print(F("  ")); Serial.print(FW_NAME);
  Serial.print(F(" v")); Serial.println(FW_VERSION);
  Serial.print(F("  ")); Serial.println(DEVICE_MODEL);
  Serial.println(F("========================================"));
  Serial.println(F("  type 'help' for commands"));
  Serial.println(F("========================================"));
}

void usb_loop() {
  while (Serial.available()) {
    int ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
s_line_buf.trim();
	      if (s_line_buf.length() > 0) {
	        Serial.print(F(">> ")); Serial.println(s_line_buf);

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