/*
 * ============================================================
 *  ble_server.cpp — BLE GATT 服务 (NimBLE)
 *
 *  Service: RING_SERVICE_UUID
 *  Char COLOR (WRITE): 收到字符串 -> cmd::handleText
 *  Char STATE (READ):  返回状态 JSON
 *
 *  使用 h2zero/NimBLE-Arduino 2.x — 自带 NimBLE 控制器,
 *  不依赖 SDK 的 Bluedroid BT 库。不要强制定义 CONFIG_BT_* 宏。
 *
 *  ESP32-C3 单天线共存要点:
 *   - WiFi PS=NONE 减少射频休眠, 让 BLE 广播有更多时间片
 *   - 广播间隔 20~40ms 提高可发现性
 *   - TX 功率设为最大 (+9dBm)
 * ============================================================
 */
#include "ble_server.h"
#include "config.h"
#include "command.h"
#include "state.h"

#if BLE_ENABLED
#include <NimBLEDevice.h>
#include <esp_wifi.h>

namespace bleServer {

static NimBLEServer*        server    = nullptr;
static NimBLEService*       service   = nullptr;
static NimBLECharacteristic* charColor = nullptr;
static NimBLECharacteristic* charState = nullptr;

// ---------- 回调 ----------
class ColorCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic* c, NimBLEConnInfo& connInfo) override {
    std::string v = c->getValue();
    String s = v.c_str();
    s.trim();
    if (s.length() == 0) return;
    String resp = cmd::handleText(s);
    if (resp.length() > 0) {
      c->setValue((const uint8_t*)resp.c_str(), resp.length());
      c->notify();
    }
  }
};

class StateCallbacks : public NimBLECharacteristicCallbacks {
  void onRead(NimBLECharacteristic* c, NimBLEConnInfo& connInfo) override {
    String s = getStateJson();
    c->setValue((const uint8_t*)s.c_str(), s.length());
  }
};

static String deviceName() {
  uint64_t m = ESP.getEfuseMac();
  uint16_t lo = (uint16_t)(m & 0xFFFF);
  char buf[8];
  snprintf(buf, sizeof(buf), "%02X%02X", (lo >> 8) & 0xFF, lo & 0xFF);
  return String(BLE_DEVICE_PREFIX) + String(buf);
}

void begin() {
  Serial.println(F("[ble] ========== BLE init start =========="));

  // ---- 1. WiFi 关闭省电 (减少射频争抢, 让 BLE 广播有更多时间片) ----
  esp_wifi_set_ps(WIFI_PS_NONE);
  Serial.println(F("[ble] WiFi PS=NONE"));

  // ---- 2. NimBLE 初始化 (内部自动初始化 BT 控制器) ----
  String name = deviceName();
  Serial.printf("[ble] calling NimBLEDevice::init(\"%s\")...\n", name.c_str());
  NimBLEDevice::init(name.c_str());
  Serial.println(F("[ble] NimBLEDevice::init returned"));

  // ---- 3. TX 功率最大 ----
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  Serial.println(F("[ble] TX power = +9dBm"));

  // ---- 4. 创建 GATT 服务和特征值 ----
  server  = NimBLEDevice::createServer();
  service = server->createService(RING_SERVICE_UUID);

  charColor = service->createCharacteristic(
      CHAR_COLOR_UUID,
      NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  const char* empty = "";
  charColor->setValue((const uint8_t*)empty, 0);
  charColor->setCallbacks(new ColorCallbacks());

  charState = service->createCharacteristic(
      CHAR_STATE_UUID,
      NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::NOTIFY);
  charState->setCallbacks(new StateCallbacks());
  const char* initStr = "init";
  charState->setValue((const uint8_t*)initStr, strlen(initStr));

  Serial.println(F("[ble] GATT service + chars created"));
  Serial.printf("[ble]   service UUID: %s\n", RING_SERVICE_UUID);
  Serial.printf("[ble]   COLOR  UUID:  %s\n", CHAR_COLOR_UUID);
  Serial.printf("[ble]   STATE  UUID:  %s\n", CHAR_STATE_UUID);

  // ---- 5. 启动广播 ----
  NimBLEAdvertising* adv = NimBLEDevice::getAdvertising();
  adv->addServiceUUID(RING_SERVICE_UUID);
  adv->setName(name.c_str());
  adv->enableScanResponse(true);

  // 广播间隔 20~40ms (0x20~0x40 * 0.625ms)
  adv->setMinInterval(0x20);
  adv->setMaxInterval(0x40);

  bool advOk = adv->start();
  Serial.printf("[ble] advertising start: %s\n", advOk ? "OK" : "FAIL");
  Serial.printf("[ble]   name: \"%s\"\n", name.c_str());
  Serial.printf("[ble]   interval: 20~40ms\n");
  Serial.println(F("[ble] ========== BLE init done =========="));

  conn.ble = advOk;
}

void loop() {
  // NimBLE 自带 FreeRTOS task 处理异步事件
}

} // namespace bleServer

#else // BLE_ENABLED = false
namespace bleServer {
void begin() { Serial.println(F("[ble] disabled at compile time")); }
void loop() {}
} // namespace bleServer
#endif
