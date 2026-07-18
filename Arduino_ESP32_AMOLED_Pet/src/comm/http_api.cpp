/*
 * ============================================================
 *  comm/http_api.cpp — HTTP REST API 实现
 *  提供 GET /state, POST /cmd 等接口
 * ============================================================
 */
#include "comm/http_api.h"
#include "comm/wifi_manager.h"
#include "state.h"
#include "command.h"
#include <Arduino.h>
#include <WebServer.h>

namespace comm {

static WebServer* s_server = nullptr;

// Kept in flash so the management page does not consume the ESP32-C6 heap.
static const char MANAGEMENT_HTML[] PROGMEM = R"HTML(
<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AgentAura</title><style>
:root{color-scheme:dark;--bg:#0b1020;--card:#151d34;--line:#2b385d;--text:#eef3ff;--muted:#9ba9ca;--accent:#58a6ff;--ok:#57d896;--bad:#ff7b93}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#1a2e58,#0b1020 52%);color:var(--text);font:15px system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:880px;margin:auto;padding:24px 16px 40px}header{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:18px}h1{font-size:28px;margin:0 0 4px}h2{font-size:16px;margin:0 0 14px}.sub,#updated{color:var(--muted);font-size:13px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}.card,.panel{background:#151d34e8;border:1px solid var(--line);border-radius:14px;padding:14px;box-shadow:0 12px 30px #0003}.panel{margin-top:14px}.k{font-size:12px;color:var(--muted);margin-bottom:5px}.v{font-size:18px;font-weight:650;overflow-wrap:anywhere}.actions{display:flex;gap:9px;flex-wrap:wrap}.row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:10px 0}.row label{min-width:78px;color:var(--muted)}button{border:1px solid #3b5c97;border-radius:9px;padding:9px 12px;background:#1d3157;color:var(--text);font:inherit;cursor:pointer}button:hover{background:#274477}button:active{transform:translateY(1px)}button:disabled{cursor:not-allowed;opacity:.42}button.warn{border-color:#9a5a68;background:#542735}input{accent-color:var(--accent)}input[type=range]{width:min(330px,100%)}input[type=text]{flex:1;min-width:180px;border:1px solid var(--line);border-radius:9px;padding:10px;background:#0c1326;color:var(--text)}.value{min-width:42px;color:var(--accent);font-variant-numeric:tabular-nums}.toast{position:fixed;left:50%;bottom:18px;transform:translateX(-50%);padding:10px 14px;border-radius:9px;background:#20365f;border:1px solid #4d79bf;opacity:0;transition:opacity .2s;pointer-events:none}.toast.show{opacity:1}.toast.err{background:#592b3a;border-color:#a8586a}@media(max-width:480px){header{display:block}.wrap{padding-top:16px}}
</style></head><body><main class="wrap"><header><div><h1>AgentAura</h1><div class="sub">设备管理控制台</div></div><div id="updated">正在连接...</div></header>
<section class="grid"><div class="card"><div class="k">桌宠状态</div><div class="v" id="pet">--</div></div><div class="card"><div class="k">Agent</div><div class="v" id="agent">--</div></div><div class="card"><div class="k">电池</div><div class="v" id="battery">--</div></div><div class="card"><div class="k">网络</div><div class="v" id="network">--</div></div></section>
<section class="panel"><h2>桌宠动画（兼容 v1 / v2）</h2><div class="actions" id="states"><button data-c="pet state idle">待机</button><button data-c="pet state running-right">向右移动</button><button data-c="pet state running-left">向左移动</button><button data-c="pet state waving">挥手</button><button data-c="pet state jumping">跳跃</button><button data-c="pet state failed">失败</button><button data-c="pet state waiting">等待输入</button><button data-c="pet state running">工作中</button><button data-c="pet state review">审阅</button><button data-v2 data-c="pet state look-directions-a">观察方向 A</button><button data-v2 data-c="pet state look-directions-b">观察方向 B</button></div><div class="sub" id="petversion">正在读取宠物版本...</div><div class="row"><label for="speech">气泡文字</label><input id="speech" type="text" maxlength="100" placeholder="显示在桌宠上方的文字"><button id="speak">发送</button></div></section>
<section class="panel"><h2>设备控制</h2><div class="row"><label for="bright">亮度</label><input id="bright" type="range" min="0" max="255" value="128"><span class="value" id="brightv">128</span><button id="applybright">应用</button></div><div class="row"><label for="volume">音量</label><input id="volume" type="range" min="0" max="100" value="50"><span class="value" id="volumev">50</span><button id="applyvolume">应用</button></div><div class="actions"><button data-c="screen pet">桌宠页</button><button data-c="screen apps">应用页</button><button data-c="screen settings">设置页</button><button id="wifi"></button><button id="ble"></button></div></section>
<section class="panel"><h2>手动命令</h2><div class="row"><input id="manual" type="text" placeholder="例如：agent type CODEX"><button id="sendmanual">执行</button></div></section>
</main><div class="toast" id="toast"></div><script>
const $=id=>document.getElementById(id),toast=$('toast');let state={};
const petStateText={idle:'待机','running-right':'向右移动','running-left':'向左移动',waving:'挥手',jumping:'跳跃',failed:'失败',waiting:'等待输入',running:'工作中',review:'审阅','look-directions-a':'观察方向 A','look-directions-b':'观察方向 B'};
function note(t,bad=false){toast.textContent=t;toast.className='toast show'+(bad?' err':'');clearTimeout(note.t);note.t=setTimeout(()=>toast.className='toast',2600)}
async function command(c){try{const r=await fetch('/api/cmd?cmd='+encodeURIComponent(c),{cache:'no-store'}),t=await r.text();if(!r.ok||!/^(OK|{)/.test(t))throw Error(t);note(t);setTimeout(refresh,180)}catch(e){note('命令失败：'+e.message,true)}}
function setv(id,v){$(id).textContent=v}function syncRange(id,v){if(document.activeElement!==$(id))$(id).value=v;setv(id+'v',v)}
async function refresh(){try{const r=await fetch('/api/state',{cache:'no-store'});if(!r.ok)throw Error('HTTP '+r.status);state=await r.json();const p=state.pet||{},a=state.agent||{},b=state.battery||{},c=state.connections||{},s=state.settings||{},petKey=String(p.state||'').toLowerCase(),spriteVersion=Number(p.sprite_version||1),isV2=spriteVersion>=2;setv('pet',petStateText[petKey]||('未知状态 ('+(petKey||'--')+')'));setv('petversion','Codex 宠物 v'+spriteVersion+' · '+(p.animation_count||9)+' 行动画');document.querySelectorAll('[data-v2]').forEach(x=>{x.disabled=!isV2;x.title=isV2?'v2 观察方向动画':'v1 不包含观察方向动画'});setv('agent',a.name||a.type||'--');setv('battery',(b.percent??'--')+'%'+(b.charging?' 充电中':''));setv('network',c.wifi?'Wi-Fi 已连接':'Wi-Fi 已关闭');$('wifi').textContent='Wi-Fi：'+(s.wifi_enabled?'开启':'关闭');$('ble').textContent='蓝牙：'+(s.ble_enabled?'开启':'关闭');syncRange('bright',s.brightness??128);syncRange('volume',s.volume??50);$('updated').textContent='更新于 '+new Date().toLocaleTimeString()}catch(e){$('updated').textContent='连接失败';note('无法读取设备状态',true)}}
document.querySelectorAll('[data-c]').forEach(x=>x.onclick=()=>command(x.dataset.c));$('wifi').onclick=()=>command('wifi '+(state.settings&&state.settings.wifi_enabled?'off':'on'));$('ble').onclick=()=>command('ble '+(state.settings&&state.settings.ble_enabled?'off':'on'));$('bright').oninput=()=>setv('brightv',$('bright').value);$('volume').oninput=()=>setv('volumev',$('volume').value);$('applybright').onclick=()=>command('brightness '+$('bright').value);$('applyvolume').onclick=()=>command('volume '+$('volume').value);$('speak').onclick=()=>{let t=$('speech').value.trim();if(t)command('pet speak '+t)};$('speech').onkeydown=e=>{if(e.key==='Enter')$('speak').click()};$('sendmanual').onclick=()=>{let t=$('manual').value.trim();if(t)command(t)};$('manual').onkeydown=e=>{if(e.key==='Enter')$('sendmanual').click()};refresh();setInterval(refresh,2000);
</script></body></html>
)HTML";

static void handle_root() {
  s_server->sendHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  s_server->send_P(200, "text/html; charset=utf-8", MANAGEMENT_HTML);
}

static void handle_state() {
  s_server->sendHeader("Cache-Control", "no-store");
  s_server->send(200, "application/json", getStateJson());
}

static void handle_cmd() {
  if (s_server->hasArg("plain")) {
    String body = s_server->arg("plain");
    String resp = cmd::handleJson(body);
    s_server->send(200, "application/json", resp);
  } else {
    s_server->send(400, "application/json", "{\"error\":\"no body\"}");
  }
}

static void handle_text_cmd() {
  if (s_server->hasArg("cmd")) {
    String cmd_text = s_server->arg("cmd");
    String resp = cmd::handleText(cmd_text);
    s_server->send(200, "text/plain", resp);
  } else {
    s_server->send(400, "text/plain", "missing 'cmd' param");
  }
}

static void handle_not_found() {
  s_server->send(404, "text/plain", "404");
}

void http_begin() {
  if (!comm::wifi_is_sta()) return;

  s_server = new WebServer(HTTP_PORT);

  s_server->on("/", HTTP_GET, handle_root);
  s_server->on("/api/state", HTTP_GET, handle_state);
  s_server->on("/api/cmd", HTTP_POST, handle_cmd);
  s_server->on("/api/cmd", HTTP_GET, handle_text_cmd);
  s_server->onNotFound(handle_not_found);

  s_server->begin();
  Serial.print(F("[http] API server started on http://"));
  Serial.print(comm::wifi_ip());
  Serial.print(F(":"));
  Serial.println(HTTP_PORT);
}

void http_loop() {
  if (s_server) s_server->handleClient();
}

} // namespace comm
