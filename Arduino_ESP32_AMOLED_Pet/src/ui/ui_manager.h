/*
 * ============================================================
 *  ui/ui_manager.h — LVGL 界面管理器
 *  管理页面路由: 桌宠 / 设置 / App启动器 / 审批弹窗
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_UI_MANAGER_H
#define AGENTAURA_UI_MANAGER_H

#include <Arduino.h>
#include <lvgl.h>
#include <functional>

namespace ui {

void ui_init();                 // 初始化 LVGL + 显示 + 触摸
void ui_loop();                 // 轮询 LVGL 任务
void ui_refresh_now();          // 立即刷新当前界面

// 页面切换
void ui_show_pet();             // 显示桌宠主界面
void ui_show_settings();        // 显示设置界面
void ui_show_apps();            // 显示 App 启动器
void ui_show_approval(const char* title, const char* desc,
                       const char* confirm_text, const char* reject_text,
                       void (*on_confirm)(void) = nullptr,
                       void (*on_reject)(void) = nullptr);
void ui_hide_approval();

// 获取 LVGL 显示缓冲区 (用于外部分配 PSRAM)
lv_disp_drv_t* ui_get_disp_drv();

} // namespace ui

#endif // AGENTAURA_UI_MANAGER_H