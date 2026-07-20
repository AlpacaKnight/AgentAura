/*
 * BLE GATT server for the ESP32-C3 ring light.
 *
 * The 128-bit service UUID is placed in the primary advertising packet so
 * service-filtered scans can discover the device. The complete device name
 * is placed in the scan response because both fields do not fit in 31 bytes.
 */
#include "ble_server.h"
#include "command.h"
#include "config.h"
#include "state.h"

#include <NimBLEDevice.h>

namespace bleServer {

static NimBLEServer*         s_server = nullptr;
static NimBLECharacteristic* s_char_color = nullptr;
static NimBLECharacteristic* s_char_state = nullptr;
static bool                  s_running = false;
static bool                  s_connected = false;
static bool                  s_init_failed = false;
static volatile int8_t       s_pending_toggle = -1;
static String                s_ble_name;
static uint32_t              s_last_adv_check_ms = 0;

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer* server, NimBLEConnInfo& connInfo) override {
    s_connected = server->getConnectedCount() > 0;
    conn.ble = s_connected;
    Serial.printf("[ble] connected: %s\n",
                  connInfo.getAddress().toString().c_str());
  }

  void onDisconnect(NimBLEServer* server,
                    NimBLEConnInfo& connInfo,
                    int reason) override {
    s_connected = server->getConnectedCount() > 0;
    conn.ble = s_connected;
    Serial.printf("[ble] disconnected: reason=%d, clients=%u\n",
                  reason,
                  static_cast<unsigned>(server->getConnectedCount()));
  }
};

class ColorCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* characteristic,
               NimBLEConnInfo& connInfo) override {
    std::string value = characteristic->getValue();
    String text = value.c_str();
    text.trim();
    if (text.length() == 0) return;

    String response = cmd::handleText(text);
    if (response.length() > 0) {
      characteristic->setValue(
          reinterpret_cast<const uint8_t*>(response.c_str()),
          response.length());
      characteristic->notify(connInfo.getConnHandle());
    }

    if (s_char_state) {
      String stateJson = getStateJson();
      s_char_state->setValue(
          reinterpret_cast<const uint8_t*>(stateJson.c_str()),
          stateJson.length());
      s_char_state->notify(connInfo.getConnHandle());
    }
  }
};

class StateCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* characteristic,
              NimBLEConnInfo& connInfo) override {
    String stateJson = getStateJson();
    characteristic->setValue(
        reinterpret_cast<const uint8_t*>(stateJson.c_str()),
        stateJson.length());
  }
};

static String deviceName() {
  const uint16_t suffix = static_cast<uint16_t>(ESP.getEfuseMac() & 0xFFFF);
  char text[5];
  snprintf(text, sizeof(text), "%04X", suffix);
  return String(BLE_DEVICE_PREFIX) + text;
}

static String shortDeviceName() {
  const uint16_t suffix = static_cast<uint16_t>(ESP.getEfuseMac() & 0xFFFF);
  char text[9];
  snprintf(text, sizeof(text), "Ring%04X", suffix);
  return String(text);
}

static bool setupGattAndAdvertising() {
  s_server = NimBLEDevice::createServer();
  if (!s_server) {
    Serial.println(F("[ble] createServer failed"));
    return false;
  }

  s_server->setCallbacks(new ServerCallbacks());
  s_server->advertiseOnDisconnect(true);

  NimBLEService* service = s_server->createService(RING_SERVICE_UUID);
  if (!service) {
    Serial.println(F("[ble] createService failed"));
    return false;
  }

  s_char_color = service->createCharacteristic(
      CHAR_COLOR_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR |
          NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  if (!s_char_color) {
    Serial.println(F("[ble] create COLOR characteristic failed"));
    return false;
  }
  s_char_color->setValue("");
  s_char_color->setCallbacks(new ColorCallbacks());

  s_char_state = service->createCharacteristic(
      CHAR_STATE_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  if (!s_char_state) {
    Serial.println(F("[ble] create STATE characteristic failed"));
    return false;
  }
  s_char_state->setValue("init");
  s_char_state->setCallbacks(new StateCallbacks());

  s_server->start();

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (!advertising) {
    Serial.println(F("[ble] getAdvertising failed"));
    return false;
  }

  NimBLEAdvertisementData primaryData;
  const String shortName = shortDeviceName();
  if (!primaryData.setFlags(BLE_HS_ADV_F_DISC_GEN |
                            BLE_HS_ADV_F_BREDR_UNSUP) ||
      !primaryData.addServiceUUID(RING_SERVICE_UUID) ||
      !primaryData.setShortName(shortName.c_str())) {
    Serial.println(F("[ble] primary advertising data is too large"));
    return false;
  }

  NimBLEAdvertisementData scanResponse;
  if (!scanResponse.setName(s_ble_name.c_str())) {
    Serial.println(F("[ble] scan response data is too large"));
    return false;
  }

  advertising->enableScanResponse(true);
  advertising->setMinInterval(0x20);
  advertising->setMaxInterval(0x40);

  if (!advertising->setAdvertisementData(primaryData) ||
      !advertising->setScanResponseData(scanResponse) ||
      !advertising->start()) {
    Serial.println(F("[ble] advertising start failed"));
    return false;
  }

  s_running = true;
  state.ble_running = true;
  Serial.printf("[ble] advertising as \"%s\", address=%s\n",
                s_ble_name.c_str(),
                NimBLEDevice::getAddress().toString().c_str());
  return true;
}

void begin() {
  if (!state.ble_enabled) {
    Serial.println(F("[ble] disabled at runtime"));
    return;
  }
  if (s_running) return;
  if (s_init_failed) {
    Serial.println(F("[ble] previous init failed; use 'bluetooth on' to retry"));
    return;
  }

  s_ble_name = deviceName();
  Serial.printf("[ble] initializing \"%s\"...\n", s_ble_name.c_str());

  if (!NimBLEDevice::init(s_ble_name.c_str()) ||
      !NimBLEDevice::isInitialized()) {
    Serial.printf("[ble] init failed; free heap=%u\n",
                  static_cast<unsigned>(ESP.getFreeHeap()));
    s_init_failed = true;
    state.ble_running = false;
    conn.ble = false;
    return;
  }

  if (!NimBLEDevice::setPower(ESP_PWR_LVL_P9)) {
    Serial.println(F("[ble] warning: failed to set TX power to +9 dBm"));
  }

  if (!setupGattAndAdvertising()) {
    NimBLEDevice::deinit(true);
    s_server = nullptr;
    s_char_color = nullptr;
    s_char_state = nullptr;
    s_running = false;
    s_connected = false;
    state.ble_running = false;
    conn.ble = false;
    s_init_failed = true;
  }
}

void loop() {
  const int8_t pending = s_pending_toggle;
  if (pending >= 0) {
    s_pending_toggle = -1;
    if (pending == 0) {
      stop();
      return;
    }

    if (!s_running) {
      s_init_failed = false;
      begin();
    }
  }

  // Some ESP32-C3/NimBLE disconnect paths do not reliably resume advertising,
  // especially while WiFi coexistence is active. Keep the GATT server alive and
  // repair advertising instead of reporting BLE as running but undiscoverable.
  if (!s_running || s_connected || !NimBLEDevice::isInitialized()) return;
  const uint32_t now = millis();
  if (now - s_last_adv_check_ms < 2000) return;
  s_last_adv_check_ms = now;

  NimBLEAdvertising* advertising = NimBLEDevice::getAdvertising();
  if (!advertising) {
    state.ble_running = false;
    return;
  }
  if (!advertising->isAdvertising()) {
    if (advertising->start()) {
      state.ble_running = true;
      Serial.println(F("[ble] advertising automatically resumed"));
    } else {
      state.ble_running = false;
      Serial.println(F("[ble] advertising resume failed; retrying"));
    }
  }
}

void stop() {
  if (NimBLEDevice::isInitialized()) {
    NimBLEDevice::deinit(true);
  }

  s_server = nullptr;
  s_char_color = nullptr;
  s_char_state = nullptr;
  s_running = false;
  s_connected = false;
  s_last_adv_check_ms = 0;
  state.ble_running = false;
  conn.ble = false;
  Serial.println(F("[ble] stopped"));
}

bool toggle(bool on) {
  state.ble_enabled = on;
  s_pending_toggle = on ? 1 : 0;
  return true;
}

bool isConnected() {
  return s_connected;
}

bool isRunning() {
  return s_running;
}

}  // namespace bleServer
