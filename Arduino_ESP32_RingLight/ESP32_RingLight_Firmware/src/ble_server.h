/*
 * ============================================================
 *  ble_server.h — BLE GATT 服务 (NimBLE)
 *  Service: RING_SERVICE_UUID
 *  Char: CHAR_COLOR_UUID (WRITE) / CHAR_STATE_UUID (READ)
 * ============================================================
 */
#pragma once
#ifndef RING_BLE_SERVER_H
#define RING_BLE_SERVER_H

#include <Arduino.h>

namespace bleServer {

void begin();
void loop();

} // namespace bleServer

#endif // RING_BLE_SERVER_H
