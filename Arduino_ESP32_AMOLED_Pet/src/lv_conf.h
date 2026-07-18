/**
 * @file lv_conf.h
 * LVGL v8.4 配置文件
 * 用于 ESP32-S3 + PSRAM 配置
 *
 * 注意: 此文件必须位于包含路径中
 * platformio.ini 已设置 -DLV_CONF_INCLUDE_SIMPLE
 */
#ifndef LV_CONF_H
#define LV_CONF_H

#include <stdint.h>

/* 颜色深度: 16-bit RGB565 (AMOLED 支持) */
#define LV_COLOR_DEPTH     16
#define LV_COLOR_16_SWAP   0

/* 使用 PSRAM 作为 LVGL 内存 */
#ifdef BOARD_HAS_PSRAM
  #define LV_MEM_CUSTOM     1
  #if LV_MEM_CUSTOM
    #define LV_MEM_CUSTOM_INCLUDE <esp_heap_caps.h>
    #define LV_MEM_POOL_INCLUDE  <esp_heap_caps.h>
    #define LV_MEM_POOL_ALLOC(size)  heap_caps_malloc(size, MALLOC_CAP_SPIRAM)
    #define LV_MEM_POOL_FREE(ptr)    free(ptr)
  #endif
#else
  #define LV_MEM_CUSTOM     0
#endif

/* 分辨率 */
#define LV_HOR_RES_MAX     368
#define LV_VER_RES_MAX     448

/* Tick 周期 (ms) */
#define LV_TICK_CUSTOM     0

/* 日志 */
#define LV_USE_LOG         0
#if LV_USE_LOG
  #define LV_LOG_PRINTF    1
  #define LV_LOG_LEVEL     LV_LOG_LEVEL_INFO
#endif

/* 使用部件 */
#define LV_USE_BTN         1
#define LV_USE_LABEL       1
#define LV_USE_BAR         1
#define LV_USE_SLIDER      1
#define LV_USE_SWITCH      1
#define LV_USE_WIN         1
#define LV_USE_CONT       1
#define LV_USE_PAGE       1
#define LV_USE_LIST       1
#define LV_USE_DROPDOWN   1
#define LV_USE_ROLLER     1
#define LV_USE_ARC        1
#define LV_USE_ANIMIMG    1
#define LV_USE_IMGBTN     1
#define LV_USE_OBJMASK    1
#define LV_USE_CHART      1
#define LV_USE_TABLE      1
#define LV_USE_CHECKBOX   1
#define LV_USE_CPICKER    1
#define LV_USE_GAUGE      1
#define LV_USE_IMG        1
#define LV_USE_LINE       1
#define LV_USE_LED        1
#define LV_USE_SPINNER    1
#define LV_USE_TEXTAREA   1
#define LV_USE_METER      1
#define LV_USE_SPAN       1
#define LV_USE_CALENDAR   0
#define LV_USE_CANVAS     1
#define LV_USE_MSGBOX     1
#define LV_USE_TABVIEW    1
#define LV_USE_TILEVIEW   1
#define LV_USE_COLORWHEEL 0
#define LV_USE_KEYBOARD   0

/* 字体 */
#define LV_FONT_MONTSERRAT_12  1
#define LV_FONT_MONTSERRAT_14  1
#define LV_FONT_MONTSERRAT_16  1
#define LV_FONT_MONTSERRAT_20  1
#define LV_FONT_MONTSERRAT_24  1
#define LV_FONT_MONTSERRAT_28  1
#define LV_FONT_MONTSERRAT_32  1
#define LV_FONT_MONTSERRAT_36  1
#define LV_FONT_MONTSERRAT_48  1
#define LV_FONT_SIMSUN_16_CJK  1

/* 动画和性能 */
#define LV_USE_ANIMATION  1
#define LV_DISP_DEF_REFR_PERIOD  30   /* ms */
#define LV_INDEV_DEF_READ_PERIOD 20   /* ms */

/* 内存池大小 (非 PSRAM 模式时) */
#if !LV_MEM_CUSTOM
  #define LV_MEM_SIZE    (64U * 1024U)
#endif

/* GPU 加速 (无硬件 GPU) */
#define LV_USE_GPU_SDL           0
#define LV_USE_GPU_STM32_DMA2D   0
#define LV_USE_GPU_NXP_PXP       0
#define LV_USE_GPU_NXP_VG_LITE   0
#define LV_USE_GPU_GD32_IPA      0
#define LV_USE_GPU_ARM2D         0

/* 文件系统 */
#define LV_USE_FS_FATFS  0
#define LV_USE_FS_STDIO  0
#define LV_USE_FS_POSIX  0
#define LV_USE_FS_WIN32  0
#define LV_USE_FS_LITTLEFS 0
#define LV_USE_FS_ARDUINO_ESP_LITTLEFS 0
#define LV_USE_FS_ARDUINO_SD 0

/* PNG (外部解码器) */
#define LV_USE_PNG  0
#define LV_USE_BMP  0
#define LV_USE_SJPG 0
#define LV_USE_GIF  0
#define LV_USE_QRCODE 0
#define LV_USE_FREETYPE 0
#define LV_USE_TINY_TTF 0

/* 断言 */
#define LV_ASSERT_HANDLER_INCLUDE <assert.h>
#define LV_ASSERT_HANDLER while(1);

#endif /* LV_CONF_H */
