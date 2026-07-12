/*
 * ============================================================
 *  comm/usb_serial.h — USB 串口通信
 *  参考环形灯固件 pollSerial() 逻辑
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_USB_SERIAL_H
#define AGENTAURA_USB_SERIAL_H

#include <Arduino.h>

namespace comm {

void usb_begin();       // 初始化 USB 串口
void usb_loop();        // 轮询: 读取串口指令并处理
void usb_send(const String& data);  // 发送数据

} // namespace comm

#endif // AGENTAURA_USB_SERIAL_H