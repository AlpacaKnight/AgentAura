/*
 * ============================================================
 *  ESP32 + WS2812 环形灯板 (24灯) 网页控制器
 *  功能：开关 / 颜色 / 亮度 / 动态灯效 / 单颗灯珠控制
 *  烧录后浏览器访问串口打印的 IP 即可看到控制面板
 * ============================================================
 *
 *  【必装库】Arduino IDE → 工具 → 管理库 → 搜 "Adafruit NeoPixel" 安装
 *            (本例使用 Adafruit_NeoPixel 驱动, 不依赖 FastLED)
 *
 *  【最重要的设置】
 *  下面的 DATA_PIN 是 WS2812 数据脚(DIN)对应的 GPIO。
 *  本店 ESP32-C3 环形灯板: DIN=IO3, 状态指示灯=IO2,
 *      BOOT 按键=IO9, 另引出 IO0/IO1  (参考示例程序)。
 *  其它板子常见取值: 2、4、5、13、15、16、27。填错灯不亮但不会损坏。
 * ============================================================
 */

#include <WiFi.h>
#include <WebServer.h>
#include <ESPmDNS.h>
#include <Adafruit_NeoPixel.h>
#include "ring_light_page.h"   // 控制面板网页 (PAGE_HTML)

// ==================== 配置区 ====================
// --- STA: 连你家路由器 (失败则自动切到 AP 模式) ---
const char* sta_ssid     = "";
const char* sta_password = "";

// --- AP: ESP32 自己发的热点 (连不上路由器时启用) ---
const char* ap_ssid      = "RingLight";
const char* ap_password  = "12345678";   // 至少8位; 留空则开放热点
const unsigned long sta_timeout = 10000; // 连路由器最多等 10 秒

// --- mDNS: 用 http://ringlight.local 访问, 不用记 IP ---
const char* mdns_name    = "ringlight";

#define NUM_LEDS     24          // 灯珠数量
#define DATA_PIN     3           // ⚠️ WS2812 的 DIN 引脚(按你的板子改)
// ===============================================

// 参数: 灯珠数, 数据引脚, 像素类型 (WS2812 = NEO_GRB + NEO_KHZ800)
Adafruit_NeoPixel strip(NUM_LEDS, DATA_PIN, NEO_GRB + NEO_KHZ800);
WebServer server(80);

// 灯效: 0=纯色 1=彩虹 2=呼吸 3=跑马灯 4=流水 5=手动保持
int effectMode = 0;
uint8_t curBrightness = 60;
uint8_t solidR = 0, solidG = 80, solidB = 255;
bool powerOn = true;

uint16_t step = 0;
unsigned long lastStep = 0;

// ---------- Adafruit_NeoPixel 没有的辅助函数 (替代 FastLED) ----------

// 8 位正弦, 替代 FastLED 的 sin8: 输入 0-255, 输出 0-255
uint8_t mySin8(uint8_t x) {
  return (uint8_t)(sin(x * 3.14159265 / 128.0) * 127.0 + 127.0);
}

// 整条灯带按比例衰减, 替代 FastLED 的 fadeToBlackBy
void fadeToBlackBy(uint8_t fade) {
  for (int i = 0; i < NUM_LEDS; i++) {
    uint32_t c = strip.getPixelColor(i);
    uint8_t r = (c >> 16) & 0xFF;
    uint8_t g = (c >> 8)  & 0xFF;
    uint8_t b =  c        & 0xFF;
    r = (uint8_t)((uint16_t)r * (255 - fade) / 255);
    g = (uint8_t)((uint16_t)g * (255 - fade) / 255);
    b = (uint8_t)((uint16_t)b * (255 - fade) / 255);
    strip.setPixelColor(i, strip.Color(r, g, b));
  }
}

// 当前颜色按亮度系数(0-255)缩放
uint32_t scaledColor(uint8_t lvl) {
  return strip.Color((uint16_t)solidR * lvl / 255,
                     (uint16_t)solidG * lvl / 255,
                     (uint16_t)solidB * lvl / 255);
}

// ---------- 灯效绘制 ----------
void fxSolid() {
  for (int i = 0; i < NUM_LEDS; i++)
    strip.setPixelColor(i, strip.Color(solidR, solidG, solidB));
}
void fxRainbow() {
  for (int i = 0; i < NUM_LEDS; i++) {
    uint8_t h = (uint8_t)((i * 256 / NUM_LEDS + step) & 0xFF);
    strip.setPixelColor(i, strip.ColorHSV((uint16_t)h << 8));   // 8位hue→16位
  }
}
void fxBreathe() {
  uint8_t b = mySin8((uint8_t)step);
  int lvl = b - 30; if (lvl < 5) lvl = 5;
  uint32_t c = scaledColor((uint8_t)lvl);
  for (int i = 0; i < NUM_LEDS; i++) strip.setPixelColor(i, c);
}
void fxChase() {
  fadeToBlackBy(40);
  strip.setPixelColor((step / 3) % NUM_LEDS, strip.Color(solidR, solidG, solidB));
}
void fxWipe() {
  int lit = step % (NUM_LEDS + 6);
  for (int i = 0; i < NUM_LEDS; i++)
    strip.setPixelColor(i, (i < lit) ? strip.Color(solidR, solidG, solidB) : 0);
}

void renderLeds() {
  if (!powerOn) { strip.clear(); strip.show(); return; }
  strip.setBrightness(curBrightness);
  switch (effectMode) {
    case 0: fxSolid();   break;
    case 1: fxRainbow(); break;
    case 2: fxBreathe(); break;
    case 3: fxChase();   break;
    case 4: fxWipe();    break;
    case 5: break;                 // 手动模式: 保持像素数据不动
  }
  strip.show();
}

// 动态灯效(1-4)按节奏推进; 纯色/手动模式不重复刷新
void tickEffect() {
  if (effectMode < 1 || effectMode > 4) return;
  unsigned long now = millis();
  int interval = 25;
  if (effectMode == 2) interval = 30;
  if (effectMode == 3) interval = 15;
  if (effectMode == 4) interval = 120;
  if (now - lastStep >= (unsigned long)interval) {
    lastStep = now; step++;
    renderLeds();
  }
}

// ==================== HTTP 处理 ====================
void handleRoot() {
  server.sendHeader("Cache-Control", "no-store");
  server.send_P(200, "text/html", PAGE_HTML);
}
void handleOn()        { powerOn = true;  renderLeds(); server.send(200, "text/plain", "on"); }
void handleOff()       { powerOn = false; renderLeds(); server.send(200, "text/plain", "off"); }
void handleColor() {
  if (server.hasArg("r")) solidR = server.arg("r").toInt();
  if (server.hasArg("g")) solidG = server.arg("g").toInt();
  if (server.hasArg("b")) solidB = server.arg("b").toInt();
  effectMode = 0; renderLeds();
  server.send(200, "text/plain", "ok");
}
void handleBrightness(){
  if (server.hasArg("v")) curBrightness = constrain(server.arg("v").toInt(), 0, 255);
  renderLeds();
  server.send(200, "text/plain", "ok");
}
void handleEffect() {
  if (server.hasArg("n")) {
    int n = server.arg("n").toInt();
    if (n >= 0 && n <= 4) { effectMode = n; step = 0; renderLeds(); }
  }
  server.send(200, "text/plain", "ok");
}
void handleLed() {
  if (server.hasArg("i") && server.hasArg("r") && server.hasArg("g") && server.hasArg("b")) {
    int i = server.arg("i").toInt();
    if (i >= 0 && i < NUM_LEDS) {
      strip.setPixelColor(i, strip.Color(server.arg("r").toInt(),
                                         server.arg("g").toInt(),
                                         server.arg("b").toInt()));
      effectMode = 5;               // 切到手动保持, 避免被灯效覆盖
      renderLeds();
    }
  }
  server.send(200, "text/plain", "ok");
}
void handleClear() { strip.clear(); effectMode = 5; strip.show(); server.send(200, "text/plain", "ok"); }
void handleNotFound() { server.send(404, "text/plain", "404: Not found"); }

// ==================== 初始化 ====================
void setup() {
  Serial.begin(115200);
  delay(200);
  strip.begin();
  strip.setBrightness(curBrightness);
  strip.show();          // 上电先全部熄灭
  renderLeds();

  WiFi.begin(sta_ssid, sta_password);
  Serial.print("Connecting to WiFi");
  unsigned long t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < sta_timeout) {
    delay(500); Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    // ----- STA 成功: 连到路由器 -----
    Serial.println();
    Serial.println("WiFi connected (STA mode)");
    Serial.print("IP address: ");
    Serial.println(WiFi.localIP());
  } else {
    // ----- STA 失败: 自动切到 AP 模式 -----
    Serial.println();
    Serial.println("STA failed, switching to AP mode...");
    WiFi.mode(WIFI_AP);
    WiFi.softAP(ap_ssid, ap_password);
    delay(100);
    Serial.println("AP started");
    Serial.print("SSID    : ");
    Serial.println(ap_ssid);
    Serial.print("Password: ");
    Serial.println(ap_password);
    Serial.print("AP IP   : ");
    Serial.println(WiFi.softAPIP());
  }

  // ----- mDNS: 用 http://<mdns_name>.local 访问 -----
  if (MDNS.begin(mdns_name)) {
    Serial.print("mDNS started: http://");
    Serial.print(mdns_name);
    Serial.println(".local");
    MDNS.addService("http", "tcp", 80);
  } else {
    Serial.println("mDNS start failed");
  }

  server.on("/",                handleRoot);
  server.on("/api/on",          handleOn);
  server.on("/api/off",         handleOff);
  server.on("/api/color",       handleColor);
  server.on("/api/brightness",  handleBrightness);
  server.on("/api/effect",      handleEffect);
  server.on("/api/led",         handleLed);
  server.on("/api/clear",       handleClear);
  server.onNotFound(handleNotFound);
  server.begin();
  Serial.println("HTTP server started");
}

void loop() {
  server.handleClient();
  tickEffect();
}
