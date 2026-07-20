/*
 * ============================================================
 *  comm/ble_server.cpp 鈥?BLE GATT 鏈嶅姟瀹炵幇
 *  鍩轰簬 NimBLE-Arduino v2.5
 * ============================================================
 */
#include "comm/ble_server.h"
#include "command.h"
#include "pin_config.h"
#include "config.h"
#include "state.h"
#include <NimBLEDevice.h>
#include <algorithm>

namespace comm {

static NimBLEServer*     s_server      = nullptr;
static NimBLECharacteristic* s_char_cmd   = nullptr;
static NimBLECharacteristic* s_char_state = nullptr;
static bool s_running  = false;
static bool s_connected = false;
static bool s_init_failed = false;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static String s_ble_name;

static String s_cmd_buf;

// 宸ュ叿鍑芥暟锛氳幏鍙?MAC 鍚庣紑
static String _mac_suffix() {
  uint64_t m = ESP.getEfuseMac();
  uint16_t lo = (uint16_t)(m & 0xFFFF);
  char buf[6];
  snprintf(buf, sizeof(buf), "%02X%02X", (lo >> 8) & 0xFF, lo & 0xFF);
  return String(buf);
}

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo) override {
    s_connected = true;
    s_conn_handle = connInfo.getConnHandle();
    state.ble_connected = true;
    conn.ble = true;
    Serial.printf("[ble] connected: %s\n", connInfo.getAddress().toString().c_str());
    NimBLEDevice::stopAdvertising();
  }

  void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
    s_connected = false;
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    state.ble_connected = false;
    conn.ble = false;
    s_cmd_buf = "";
    Serial.println(F("[ble] disconnected"));
    NimBLEDevice::startAdvertising();
  }
};

class CharCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
    std::string val = pChar->getValue();
    if (val.length() > 0) {
      s_cmd_buf += String(val.c_str());
      // 鎸夎澶勭悊
      int idx;
      while ((idx = s_cmd_buf.indexOf('\n')) >= 0) {
        String line = s_cmd_buf.substring(0, idx);
        line.trim();
        s_cmd_buf = s_cmd_buf.substring(idx + 1);
if (line.length() > 0) {
	          // 璺敱鍒?command parser
	          Serial.printf("[ble] cmd: %s\n", line.c_str());
	          String resp = ">> BLE: " + line + "\n";
	          String cmd_resp = cmd::handleText(line);
	          if (cmd_resp.length() > 0) {
	            resp += cmd_resp;
	          }
	          ble_send(resp);
	        }
      }
    }
  }
};

class StateCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* pChar, NimBLEConnInfo& connInfo) override {
    String snapshot = getBleStateJson();
    pChar->setValue(
      reinterpret_cast<const uint8_t*>(snapshot.c_str()), snapshot.length());
    Serial.printf("[ble] state read: %u bytes\n",
                  static_cast<unsigned>(snapshot.length()));
  }
};

static bool setup_services() {
  s_server = NimBLEDevice::createServer();
  if (!s_server) return false;
  s_server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = s_server->createService(SERVICE_UUID);
  if (!svc) return false;

  // 鍛戒护鐗瑰緛: write
  s_char_cmd = svc->createCharacteristic(
    CHAR_CMD_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  s_char_cmd->setCallbacks(new CharCallbacks());

  // 鐘舵€佺壒寰? notify
  s_char_state = svc->createCharacteristic(
    CHAR_STATE_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  s_char_state->setCallbacks(new StateCallbacks());
  s_char_state->setValue("{}");

  // NimBLE v2.5 会在 server 启动时自动发布 service，无需再显式 start()
  // 广播包容量只有 31 字节。设备名已在 NimBLEDevice::init() 设置，
  // 这里仅广播 Service UUID，避免 name + UUID 同时放入导致超长报错。
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  if (!adv) return false;
  adv->addServiceUUID(SERVICE_UUID);
  // A 128-bit service UUID and the full local name do not fit in the
  // 31-byte primary advertisement. Keep the UUID in the primary packet and
  // publish the friendly name in the scan response.
  NimBLEAdvertisementData scan_data;
  scan_data.setName(s_ble_name.c_str());
  adv->enableScanResponse(true);
  if (!adv->setScanResponseData(scan_data) || !adv->start()) return false;

  s_running = true;
  state.ble_running = true;
  Serial.printf("[ble] service started as %s\n", s_ble_name.c_str());
  return true;
}

void ble_begin() {
  if (state.ble_enabled != RadioState::ON) {
    Serial.println(F("[ble] disabled by user"));
    return;
  }
  if (s_init_failed) {
    Serial.println(F("[ble] init previously failed; retry after reboot"));
    return;
  }

  s_ble_name = String(BLE_DEVICE_PREFIX) + _mac_suffix();
  if (!NimBLEDevice::init(s_ble_name.c_str()) ||
      !NimBLEDevice::isInitialized()) {
    Serial.printf("[ble] init failed; free heap=%u, BLE disabled\n",
                  static_cast<unsigned>(ESP.getFreeHeap()));
    s_running = false;
    state.ble_running = false;
    state.ble_connected = false;
    conn.ble = false;
    s_init_failed = true;
    return;
  }
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // 鏈€澶у彂灏勫姛鐜?

  if (!setup_services()) {
    Serial.printf("[ble] service setup failed; free heap=%u\n",
                  static_cast<unsigned>(ESP.getFreeHeap()));
    NimBLEDevice::deinit(true);
    s_server = nullptr;
    s_char_cmd = nullptr;
    s_char_state = nullptr;
    s_running = false;
    state.ble_running = false;
    s_init_failed = true;
  }
}

void ble_loop() {
  // NimBLE 鍦ㄥ悗鍙拌繍琛? 鏃犻渶棰濆澶勭悊
}

void ble_stop() {
  if (s_server) {
    NimBLEDevice::deinit(true);
    s_server = nullptr;
    s_running = false;
    state.ble_running = false;
    s_connected = false;
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    s_char_cmd = nullptr;
    s_char_state = nullptr;
    s_cmd_buf = "";
    state.ble_connected = false;
    conn.ble = false;
    Serial.println(F("[ble] stopped"));
  }
}

bool ble_toggle(bool on) {
  if (on) {
    state.ble_enabled = RadioState::ON;
    if (!s_running) {
      ble_begin();
    }
    return s_running;
  } else {
    state.ble_enabled = RadioState::OFF;
    if (s_running) {
      ble_stop();
    }
    return !s_running;
  }
}

bool ble_is_connected() {
  return s_connected;
}

bool ble_is_running() {
  return s_running;
}

void ble_send(const String& data) {
  if (s_connected && s_char_state) {
    // Notifications are limited to ATT_MTU - 3 bytes. Split long command
    // responses (especially `state`) instead of silently truncating them.
    uint16_t mtu = s_server && s_conn_handle != BLE_HS_CONN_HANDLE_NONE
                     ? s_server->getPeerMTU(s_conn_handle) : 23;
    size_t chunk_size = std::max<size_t>(1, mtu > 3 ? mtu - 3 : 20);
    for (size_t offset = 0; offset < data.length(); offset += chunk_size) {
      size_t length = std::min(chunk_size, data.length() - offset);
      if (!s_char_state->notify(
            reinterpret_cast<const uint8_t*>(data.c_str() + offset),
            length, s_conn_handle)) {
        Serial.printf("[ble] notify failed at %u/%u\n",
                      static_cast<unsigned>(offset),
                      static_cast<unsigned>(data.length()));
        break;
      }
      delay(3);
    }
  }
}

} // namespace comm

