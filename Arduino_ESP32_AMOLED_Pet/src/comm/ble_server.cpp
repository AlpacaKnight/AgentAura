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

namespace comm {

static NimBLEServer*     s_server      = nullptr;
static NimBLECharacteristic* s_char_cmd   = nullptr;
static NimBLECharacteristic* s_char_state = nullptr;
static bool s_running  = false;
static bool s_connected = false;
static bool s_init_failed = false;

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
    state.ble_connected = true;
    conn.ble = true;
    Serial.printf("[ble] connected: %s\n", connInfo.getAddress().toString().c_str());
    NimBLEDevice::stopAdvertising();
  }

  void onDisconnect(NimBLEServer* pServer, NimBLEConnInfo& connInfo, int reason) override {
    s_connected = false;
    state.ble_connected = false;
    conn.ble = false;
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

static void setup_services() {
  s_server = NimBLEDevice::createServer();
  s_server->setCallbacks(new ServerCallbacks());

  NimBLEService* svc = s_server->createService(SERVICE_UUID);

  // 鍛戒护鐗瑰緛: write
  s_char_cmd = svc->createCharacteristic(
    CHAR_CMD_UUID,
    NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  s_char_cmd->setCallbacks(new CharCallbacks());

  // 鐘舵€佺壒寰? notify
  s_char_state = svc->createCharacteristic(
    CHAR_STATE_UUID,
    NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);  s_char_state->setValue("");

  // NimBLE v2.5 会在 server 启动时自动发布 service，无需再显式 start()
  // 广播包容量只有 31 字节。设备名已在 NimBLEDevice::init() 设置，
  // 这里仅广播 Service UUID，避免 name + UUID 同时放入导致超长报错。
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(SERVICE_UUID);
  adv->start();

  s_running = true;
  Serial.println(F("[ble] service started"));
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

  String ble_name = String(BLE_DEVICE_PREFIX) + _mac_suffix();
  if (!NimBLEDevice::init(ble_name.c_str()) ||
      !NimBLEDevice::isInitialized()) {
    Serial.printf("[ble] init failed; free heap=%u, BLE disabled\n",
                  static_cast<unsigned>(ESP.getFreeHeap()));
    s_running = false;
    state.ble_connected = false;
    conn.ble = false;
    s_init_failed = true;
    return;
  }
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);  // 鏈€澶у彂灏勫姛鐜?

  setup_services();
}

void ble_loop() {
  // NimBLE 鍦ㄥ悗鍙拌繍琛? 鏃犻渶棰濆澶勭悊
}

void ble_stop() {
  if (s_server) {
    NimBLEDevice::deinit(true);
    s_server = nullptr;
    s_running = false;
    s_connected = false;
    state.ble_connected = false;
    conn.ble = false;
    Serial.println(F("[ble] stopped"));
  }
}

void ble_toggle(bool on) {
  if (on) {
    if (!s_running) {
      state.ble_enabled = RadioState::ON;
      ble_begin();
    }
  } else {
    if (s_running) {
      state.ble_enabled = RadioState::OFF;
      ble_stop();
    }
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
    s_char_state->setValue(data.c_str());
    s_char_state->notify();
  }
}

} // namespace comm

