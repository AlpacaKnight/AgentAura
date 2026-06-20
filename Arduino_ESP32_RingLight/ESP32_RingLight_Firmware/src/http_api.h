/*
 * ============================================================
 *  http_api.h — REST API + Web 控制面板 + WLED 兼容
 *  仅在 STA 连接成功时启用 (AP 模式下 network.cpp 挂自己的配置页)
 * ============================================================
 */
#pragma once
#ifndef RING_HTTP_API_H
#define RING_HTTP_API_H

#include <Arduino.h>

namespace httpApi {

void begin();
void loop();

} // namespace httpApi

#endif // RING_HTTP_API_H
