/*
 * ============================================================
 *  hal/audio.cpp — 音频引擎实现 (ES8311 over I2S)
 * ============================================================
 */
#include "hal/audio.h"
#include "pin_config.h"
#include <Arduino.h>
#include <hal/i2s_types.h>
#include <driver/i2s.h>
#include <driver/gpio.h>
#include <Wire.h>

namespace hal {

// ES8311 寄存器定义
#define ES8311_REG_RESET      0x00
#define ES8311_REG_CLOCK_MAN  0x01
#define ES8311_REG_CLOCK_MODE 0x02
#define ES8311_REG_LRCFG      0x03
#define ES8311_REG_LRADC_CTRL 0x04
#define ES8311_REG_DAC_CTRL1  0x05
#define ES8311_REG_DAC_CTRL2  0x06
#define ES8311_REG_ADC_CTRL1  0x07
#define ES8311_REG_ADC_CTRL2  0x08
#define ES8311_REG_SEL_CTRL   0x09
#define ES8311_REG_DAC_PAD    0x0A

#define ES8311_REG_DAC_LVOL   0x0E  // 左声道数字音量 (0x00=静音, 0x60=0dB)
#define ES8311_REG_DAC_RVOL   0x0F  // 右声道数字音量
#define ES8311_REG_DAC_VOICE  0x10  // 语音音量
#define ES8311_REG_ADC_ALC1   0x11
#define ES8311_REG_ADC_ALC2   0x12
#define ES8311_REG_ADC_ALC3   0x13
#define ES8311_REG_ADC_VOLUME 0x14
#define ES8311_REG_LIN_VOL    0x15
#define ES8311_REG_RIN_VOL    0x16
#define ES8311_REG_LADC_VOL   0x17
#define ES8311_REG_RADC_VOL   0x18

static uint8_t s_volume = DEFAULT_VOLUME;
static bool s_initialized = false;

static bool es8311_write_reg(uint8_t reg, uint8_t data) {
  Wire.beginTransmission(ES8311_ADDR);
  Wire.write(reg);
  Wire.write(data);
  return Wire.endTransmission() == 0;
}

static bool es8311_read_reg(uint8_t reg, uint8_t* data) {
  Wire.beginTransmission(ES8311_ADDR);
  Wire.write(reg);
  if (Wire.endTransmission() != 0) return false;
  Wire.requestFrom(ES8311_ADDR, (uint8_t)1);
  if (!Wire.available()) return false;
  *data = Wire.read();
  return true;
}

void audio_init() {
  // I2C 已在 pmu_init() 中初始化, 这里不再重复调用 Wire.begin()

  // 复位 ES8311
  es8311_write_reg(ES8311_REG_RESET, 0x1F);
  delay(50);
  es8311_write_reg(ES8311_REG_RESET, 0x1F);
  delay(50);

  // 验证芯片 ID
  uint8_t chip_id = 0;
  if (es8311_read_reg(0x1F, &chip_id)) {
    Serial.printf("[audio] ES8311 chip ID: 0x%02X\n", chip_id);
  } else {
    Serial.println(F("[audio] ES8311 I2C not responding!"));
    // 仍然初始化 I2S，可能功放独立工作
  }

  // 时钟配置
  es8311_write_reg(ES8311_REG_CLOCK_MAN, 0x50);  // MCLK = BCLK/2, slave
  es8311_write_reg(ES8311_REG_CLOCK_MODE, 0x00); // 内部 OSC
  es8311_write_reg(ES8311_REG_LRCFG, 0x02);      // I2S 16-bit

  // DAC 配置
  es8311_write_reg(ES8311_REG_DAC_CTRL1, 0x08);  // 使能 DAC
  es8311_write_reg(ES8311_REG_DAC_CTRL2, 0x48);  // 设置 DAC 采样率
  es8311_write_reg(ES8311_REG_DAC_PAD, 0x80);     // 使能 DAC 输出

  // 设置初始音量
  audio_set_volume(s_volume);
  i2s_config_t i2s_config = {
    .mode = (i2s_mode_t)(I2S_MODE_MASTER | I2S_MODE_TX),
    .sample_rate = 16000,
    .bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT,
    .channel_format = I2S_CHANNEL_FMT_ONLY_LEFT,
    .communication_format = I2S_COMM_FORMAT_STAND_I2S,
    .intr_alloc_flags = ESP_INTR_FLAG_LEVEL1,
    .dma_buf_count = 4,
    .dma_buf_len = 1024,
    .use_apll = false,
    .tx_desc_auto_clear = true,
    .fixed_mclk = 0,
    .mclk_multiple = I2S_MCLK_MULTIPLE_256,
    .bits_per_chan = I2S_BITS_PER_CHAN_16BIT,
  };

  i2s_pin_config_t pin_config = {
    .mck_io_num = I2S_MCK_IO,
    .bck_io_num = I2S_BCK_IO,
    .ws_io_num = I2S_WS_IO,
    .data_out_num = I2S_DO_IO,
    .data_in_num = I2S_DI_IO,
  };

  esp_err_t err = i2s_driver_install(I2S_NUM_0, &i2s_config, 0, NULL);
  if (err != ESP_OK) {
    Serial.printf("[audio] i2s_driver_install failed: %d\n", err);
    return;
  }

  err = i2s_set_pin(I2S_NUM_0, &pin_config);
  if (err != ESP_OK) {
    Serial.printf("[audio] i2s_set_pin failed: %d\n", err);
    return;
  }

  // 功放使能：当前板级定义里的 PA_PIN 未核准，先避免访问无效 GPIO
  if (GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)PA_PIN)) {
    pinMode(PA_PIN, OUTPUT);
    digitalWrite(PA_PIN, HIGH);
  } else {
    Serial.printf("[audio] skip PA enable: invalid pin %d\n", PA_PIN);
  }

  s_initialized = true;
  Serial.println(F("[audio] ES8311 init OK"));
}

void audio_set_volume(uint8_t vol) {
  s_volume = constrain(vol, 0, 100);

  // ES8311 数字音量映射: 0→静音, 100→0dB
  // 寄存器值: 0x00=静音, 0x60=0dB (线性, 步进0.5dB)
  // 映射公式: reg = vol * 0x60 / 100
  uint8_t reg_val = (uint8_t)(s_volume * 0x60 / 100);
  if (reg_val > 0x60) reg_val = 0x60;

  es8311_write_reg(ES8311_REG_DAC_LVOL, reg_val);
  es8311_write_reg(ES8311_REG_DAC_RVOL, reg_val);

  Serial.printf("[audio] volume set to %d (reg 0x%02X)\n", s_volume, reg_val);
}

void audio_play_tone() {
  if (!s_initialized) return;

  // 简单的正弦波提示音
  const int freq = 800;
  const int duration = 200;  // ms
  const int sample_rate = 16000;
  const int samples = sample_rate * duration / 1000;

  int16_t* buf = (int16_t*)malloc(samples * sizeof(int16_t));
  if (!buf) return;

  float vol = s_volume / 100.0f * 0.3f;
  for (int i = 0; i < samples; i++) {
    float t = (float)i / sample_rate;
    buf[i] = (int16_t)(sinf(2 * PI * freq * t) * 32767 * vol);
  }

  size_t written;
  i2s_write(I2S_NUM_0, buf, samples * sizeof(int16_t), &written, portMAX_DELAY);
  free(buf);
}

void audio_speaker_enable(bool on) {
  if (GPIO_IS_VALID_OUTPUT_GPIO((gpio_num_t)PA_PIN)) {
    digitalWrite(PA_PIN, on ? HIGH : LOW);
  }
}

} // namespace hal