/*
 * ============================================================
 *  hal/audio.h — 音频引擎 HAL (ES8311)
 * ============================================================
 */
#pragma once
#ifndef AGENTAURA_AUDIO_H
#define AGENTAURA_AUDIO_H

#include <Arduino.h>

namespace hal {

void audio_init();              // 初始化 ES8311
void audio_set_volume(uint8_t vol); // 音量 0-100
void audio_play_tone();         // 播放提示音
void audio_speaker_enable(bool on);  // 功放开关

} // namespace hal

#endif // AGENTAURA_AUDIO_H