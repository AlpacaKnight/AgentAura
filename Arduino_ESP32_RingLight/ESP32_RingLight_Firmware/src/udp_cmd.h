/*
 * ============================================================
 *  udp_cmd.h — UDP 文本指令 + 局域网广播发现
 *  端口 UDP_PORT (默认 8888), 与串口指令同格式
 * ============================================================
 */
#pragma once
#ifndef RING_UDP_CMD_H
#define RING_UDP_CMD_H

#include <Arduino.h>

namespace udpCmd {

void begin();
void loop();

} // namespace udpCmd

#endif // RING_UDP_CMD_H
