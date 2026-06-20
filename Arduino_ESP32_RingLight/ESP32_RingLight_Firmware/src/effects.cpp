/*
 * ============================================================
 *  effects.cpp — 15 种灯效实现 (NUM_LEDS 无关)
 *
 *  所有效果操作全局 leds[NUM_LEDS] 缓冲,
 *  真正的 show() 由 led_driver 调度时统一执行.
 *
 *  动画节奏: animStep 在 led_driver.loop 中按 state.speed
 *  推进 (speed 越大, 间隔越短).
 * ============================================================
 */
#include "effects.h"

CRGB leds[NUM_LEDS];
uint16_t animStep = 0;

// ---------- 名称 <-> 枚举 ----------
struct EffectEntry { const char* name; EffectType e; };
static const EffectEntry kEffectTable[] = {
  {"solid",    EFX_SOLID},
  {"breath",   EFX_BREATH},
  {"flow",     EFX_FLOW},
  {"rainbow",  EFX_RAINBOW},
  {"gradient", EFX_GRADIENT},
  {"blink",    EFX_BLINK},
  {"fire",     EFX_FIRE},
  {"sparkle",  EFX_SPARKLE},
  {"cycle",    EFX_CYCLE},
  {"meteor",   EFX_METEOR},
  {"bounce",   EFX_BOUNCE},
  {"wave",     EFX_WAVE},
  {"pulse",    EFX_PULSE},
  {"fade",     EFX_FADE},
  {"random",   EFX_RANDOM},
};

static String toLower(const String& s) {
  String r = s;
  for (auto& c : r) {
    if (c >= 'A' && c <= 'Z') c = char(c + ('a' - 'A'));
  }
  return r;
}

EffectType effectFromName(const String& name) {
  String n = toLower(name);
  n.trim();
  for (const auto& e : kEffectTable) {
    if (n == e.name) return e.e;
  }
  return EFX_INVALID;
}

const char* effectName(EffectType e) {
  for (const auto& entry : kEffectTable) {
    if (entry.e == e) return entry.name;
  }
  return "solid";
}

void resetAnimStep() { animStep = 0; }

void resetEffect(EffectType e) {
  animStep = 0;
  if (e != EFX_METEOR && e != EFX_BOUNCE && e != EFX_WAVE &&
      e != EFX_SPARKLE && e != EFX_FIRE) {
    // 不带拖尾的效果切到时清屏, 避免上一效果残留
    FastLED.clear();
  }
}

// ---------- 工具: 居中/索引 ----------
static inline uint16_t posMod(int16_t p, uint16_t n) {
  int16_t m = p % (int16_t)n;
  if (m < 0) m += n;
  return (uint16_t)m;
}

// ============================================================
//                       15 种效果
// ============================================================

// 1. solid: 单色常亮
static void fxBreathS(const CRGB& c1, const CRGB&) {
  fill_solid(leds, NUM_LEDS, c1);
}

// 2. breath: 正弦呼吸 (speed=128 时 ~5 秒一个周期)
static void fxBreath(const CRGB& c1, const CRGB&) {
  uint8_t lvl = sin8((uint8_t)((animStep * 10) & 0xFF));  // ×10 加速呼吸节奏
  // 让最低不低于 ~8, 避免"完全黑"
  uint8_t b = scale8(lvl, 240) + 8;
  CRGB c = c1;
  c.nscale8(b);
  fill_solid(leds, NUM_LEDS, c);
}

// 3. flow: 跑马/流水 (单点亮起 + 拖尾)
static void fxFlow(const CRGB& c1, const CRGB&) {
  fadeToBlackBy(leds, NUM_LEDS, 60);
  uint16_t pos = animStep % NUM_LEDS;
  leds[pos] = c1;
}

// 4. rainbow: 彩虹渐变轮转 (每帧 hue 步进 8, 转动明显)
static void fxRainbow(const CRGB&, const CRGB&) {
  uint8_t startHue = (uint8_t)((animStep * 8) & 0xFF);
  fill_rainbow(leds, NUM_LEDS, startHue, 256 / NUM_LEDS);
}

// 5. gradient: 双色渐变 (环上过渡)
static void fxGradient(const CRGB& c1, const CRGB& c2) {
  fill_gradient_RGB(leds, NUM_LEDS, c1, c2);
  // 让双色沿环旋转
  uint8_t rot = (uint8_t)(animStep & 0xFF);
  // 简化处理: 每 N 步整体偏移一次 (用 CRGBSet 旋转)
  if (rot != 0) {
    static CRGB buf[NUM_LEDS];
    for (uint16_t i = 0; i < NUM_LEDS; i++) {
      buf[i] = leds[(i + (rot >> 3)) % NUM_LEDS];
    }
    memcpy(leds, buf, sizeof(buf));
  }
}

// 6. blink: 交替亮灭
static void fxBlink(const CRGB& c1, const CRGB&) {
  bool on = ((animStep >> 2) & 1) == 0;   // 每推进 4 步翻一次
  fill_solid(leds, NUM_LEDS, on ? c1 : CRGB::Black);
}

// 7. fire: 火焰模拟 (HeatColors 调色板)
static void fxFire(const CRGB&, const CRGB&) {
  // 每帧随机扰动, 模拟火焰跳动
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    uint8_t heat = random8(120, 255);
    leds[i] = ColorFromPalette(HeatColors_p, heat);
  }
  // 偶尔插入暗点模拟空气
  if (random8() < 40) {
    leds[random16(NUM_LEDS)] = CRGB::Black;
  }
}

// 8. sparkle: 底色 + 随机白点星光
static void fxSparkle(const CRGB& c1, const CRGB&) {
  fadeToBlackBy(leds, NUM_LEDS, 40);
  // 维持底色 (低亮度)
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    leds[i] |= CRGB(c1).nscale8(32);
  }
  // 随机点亮几个白星
  if (random8() < 90) leds[random16(NUM_LEDS)] = CRGB::White;
}

// 9. cycle: 以传入颜色 hue 为中心的色相循环 (紫色渐变循环)
static void fxCycle(const CRGB& c1, const CRGB&) {
  CHSV hsv = rgb2hsv_approximate(c1);     // 取传入颜色的色相
  uint8_t baseHue = hsv.hue;
  // 在 baseHue 附近 ±32 做缓慢摆动, 保持是同一色系 (如紫色系)
  uint8_t hue = baseHue + (int8_t)(sin8((uint8_t)(animStep & 0xFF)) - 128) / 4;
  fill_solid(leds, NUM_LEDS, CHSV(hue, hsv.sat, 200));
}

// 10. meteor: 流星拖尾
static void fxMeteor(const CRGB& c1, const CRGB&) {
  fadeToBlackBy(leds, NUM_LEDS, 64);
  uint16_t pos = animStep % (NUM_LEDS + 6);
  if (pos < NUM_LEDS) leds[pos] = c1;
  // 头部更亮 (叠加白色高光)
  if (pos < NUM_LEDS) leds[pos] |= CRGB(80, 80, 80);
}

// 11. bounce: 弹跳来回
static void fxBounce(const CRGB& c1, const CRGB&) {
  fadeToBlackBy(leds, NUM_LEDS, 90);
  uint16_t cycle = (NUM_LEDS - 1) * 2;
  uint16_t p = animStep % cycle;
  uint16_t pos = (p < NUM_LEDS) ? p : (cycle - p);
  if (pos < NUM_LEDS) leds[pos] = c1;
}

// 12. wave: 多色波浪推进 (双色交替 + 正弦强度)
static void fxWave(const CRGB& c1, const CRGB& c2) {
  for (uint16_t i = 0; i < NUM_LEDS; i++) {
    uint8_t phase = (uint8_t)((i * 16 + animStep) & 0xFF);
    uint8_t s = sin8(phase);
    // s=0 -> c2, s=255 -> c1
    CRGB c = blend(c2, c1, s);
    leds[i] = c;
  }
}

// 13. pulse: 快速闪后渐暗
static void fxPulse(const CRGB& c1, const CRGB&) {
  uint16_t phase = animStep % 24;   // 24 步一个脉冲
  uint8_t b;
  if (phase < 2) b = 255;           // 头部全亮
  else b = (uint8_t)(255 - (phase - 2) * 12);   // 线性衰减
  if (b > 250) b = 255;
  CRGB c = c1;
  c.nscale8(b);
  fill_solid(leds, NUM_LEDS, c);
}

// 14. fade: 淡入淡出 (色弱交替)
static void fxFade(const CRGB& c1, const CRGB&) {
  uint8_t s = sin8((uint8_t)(animStep & 0xFF));
  CRGB c = c1;
  c.nscale8(s);
  fill_solid(leds, NUM_LEDS, c);
}

// ---------- 15. random: 每隔一段时间随机切换 ----------
static unsigned long sRandomLast = 0;
static const unsigned long sRandomInterval = 6000UL; // 6 秒换一次
static EffectType sRandomCurrent = EFX_BREATH;

void tickRandomEffect() {
  unsigned long now = millis();
  if (now - sRandomLast >= sRandomInterval) {
    sRandomLast = now;
    // 从 1..14 (排除 solid 与 random 自身) 随机选
    uint8_t r;
    do { r = random8(1, EFX_COUNT); } while (r == EFX_RANDOM);
    sRandomCurrent = (EffectType)r;
    animStep = 0;
  }
}

// ============================================================
void drawEffect(EffectType e, const CRGB& c1, const CRGB& c2) {
  // RANDOM 特殊: 转发到当前随机效果
  if (e == EFX_RANDOM) {
    tickRandomEffect();
    e = sRandomCurrent;
  }
  switch (e) {
    case EFX_SOLID:    fxBreathS(c1, c2); break;
    case EFX_BREATH:   fxBreath(c1, c2);  break;
    case EFX_FLOW:     fxFlow(c1, c2);    break;
    case EFX_RAINBOW:  fxRainbow(c1, c2); break;
    case EFX_GRADIENT: fxGradient(c1, c2);break;
    case EFX_BLINK:    fxBlink(c1, c2);   break;
    case EFX_FIRE:     fxFire(c1, c2);    break;
    case EFX_SPARKLE:  fxSparkle(c1, c2); break;
    case EFX_CYCLE:    fxCycle(c1, c2);   break;
    case EFX_METEOR:   fxMeteor(c1, c2);  break;
    case EFX_BOUNCE:   fxBounce(c1, c2);  break;
    case EFX_WAVE:     fxWave(c1, c2);    break;
    case EFX_PULSE:    fxPulse(c1, c2);   break;
    case EFX_FADE:     fxFade(c1, c2);    break;
    default:           fxBreathS(c1, c2); break;
  }
}
