/*
 * ============================================================
 *  comm/http_api.h — HTTP REST API
 *  提供设备状态查询和控制接口
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_HTTP_API_H
#define AGENTAURA_HTTP_API_H

#include <Arduino.h>

namespace comm {

void http_begin();      // 启动 HTTP 服务
void http_loop();       // 轮询 HTTP 请求

} // namespace comm

#endif // AGENTAURA_HTTP_API_H