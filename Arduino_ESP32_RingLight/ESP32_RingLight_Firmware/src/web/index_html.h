/*
 * ============================================================
 *  web/index_html.h — Web 控制面板 (PROGMEM 单页, 无外部依赖)
 *  覆盖: 电源/亮度/速度/颜色/15 灯效/智能体状态/状态展示
 * ============================================================
 */
#ifndef RING_WEB_INDEX_HTML_H
#define RING_WEB_INDEX_HTML_H

const char INDEX_HTML[] PROGMEM = R"=====(
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ESP32 Ring Light</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
     background:linear-gradient(135deg,#0f172a,#1e293b);min-height:100vh;
     padding:16px;color:#e2e8f0}
.wrap{max-width:560px;margin:0 auto}
h1{text-align:center;font-size:22px;margin-bottom:2px}
.sub{text-align:center;color:#94a3b8;font-size:13px;margin-bottom:14px}
.card{background:#1e293b;border:1px solid #334155;border-radius:14px;
      padding:14px;margin-bottom:12px;box-shadow:0 4px 16px rgba(0,0,0,.3)}
.card h3{font-size:14px;color:#38bdf8;margin-bottom:10px;font-weight:600}
.row{display:flex;gap:8px;flex-wrap:wrap}
.btn{flex:1;min-width:80px;padding:10px;border:none;border-radius:9px;
     cursor:pointer;font-size:13px;font-weight:600;background:#334155;color:#e2e8f0;
     transition:.15s}
.btn:hover{background:#475569}
.btn:active{transform:translateY(1px)}
.btn.off{background:#475569}
.btn.fx{background:#1e3a5f}
.btn.fx.on{background:#0ea5e9;color:#000}
.btn.agent{background:#312e81}
.btn.agent.on{background:#8b5cf6;color:#fff}
.label{font-size:12px;color:#94a3b8;margin:8px 0 5px}
input[type=range]{width:100%;accent-color:#0ea5e9}
.val{float:right;color:#0ea5e9;font-weight:bold;font-size:13px}
#picked{width:44px;height:44px;border-radius:8px;border:2px solid #fff;
        background:#00ff00;vertical-align:middle;margin-right:10px}
.swatch{display:inline-block;width:26px;height:26px;border-radius:6px;
        border:1px solid #fff;margin:3px;cursor:pointer}
.status{font:12px Consolas,monospace;background:#020617;border-radius:8px;
        padding:10px;color:#4ade80;line-height:1.7;white-space:pre-wrap;
        word-break:break-all;min-height:60px}
a.cfg{color:#38bdf8;text-decoration:none;font-size:12px}
</style>
</head>
<body>
<div class="wrap">
  <h1>🌈 ESP32 Ring Light</h1>
  <div class="sub">v1.0 · 5 连接 · 15 灯效 · <a class="cfg" href="/config">配置</a></div>

  <div class="card">
    <h3>电源 / 亮度 / 速度</h3>
    <div class="row">
      <button class="btn" onclick="cmd('power on')">开</button>
      <button class="btn off" onclick="cmd('power off')">关</button>
    </div>
    <div class="label">亮度 <span class="val" id="vBrt">128</span></div>
    <input type="range" id="brt" min="0" max="255" value="128"
      oninput="cmd('brightness '+this.value);document.getElementById('vBrt').textContent=this.value">
    <div class="label">速度 <span class="val" id="vSpd">128</span></div>
    <input type="range" id="spd" min="0" max="255" value="128"
      oninput="cmd('speed '+this.value);document.getElementById('vSpd').textContent=this.value">
  </div>

  <div class="card">
    <h3>颜色</h3>
    <div style="margin-bottom:8px">
      <span id="picked"></span>
      <input type="color" id="cp" value="#00ff00" oninput="setColor(this.value)">
    </div>
    <div id="swatches"></div>
  </div>

  <div class="card">
    <h3>15 种灯效</h3>
    <div class="row" id="fxRow"></div>
  </div>

  <div class="card">
    <h3>智能体状态</h3>
    <div class="row" id="agentRow"></div>
  </div>

  <div class="card">
    <h3>当前状态 <button class="btn" style="flex:0 0 auto;padding:4px 10px" onclick="loadState()">刷新</button></h3>
    <div class="status" id="status">加载中...</div>
  </div>
</div>

<script>
var EFFECTS=['solid','breath','flow','rainbow','gradient','blink','fire',
  'sparkle','cycle','meteor','bounce','wave','pulse','fade','random'];
var AGENTS=[
  {n:'running',l:'🟢 正常'},
  {n:'busy',l:'🟡 忙碌'},
  {n:'waiting',l:'🟡 待审批'},
  {n:'error',l:'🔴 错误'},
  {n:'idle',l:'🔵 空闲'},
  {n:'init',l:'🟣 初始化'},
  {n:'offline',l:'⚪ 离线'},
  {n:'upgrade',l:'🟠 升级中'}
];
(function(){
  var fr=document.getElementById('fxRow');
  EFFECTS.forEach(function(e){
    var b=document.createElement('button');b.className='btn fx';b.textContent=e;
    b.dataset.fx=e;b.onclick=function(){cmd('effect '+e);markFx(e);};
    fr.appendChild(b);
  });
  var ar=document.getElementById('agentRow');
  AGENTS.forEach(function(a){
    var b=document.createElement('button');b.className='btn agent';b.textContent=a.l;
    b.dataset.ag=a.n;b.onclick=function(){cmd('agent '+a.n);markAg(a.n);};
    ar.appendChild(b);
  });
  var presets=['#ff0000','#ff8c00','#ffff00','#00ff00','#00ffff',
    '#0050ff','#8a2be2','#ff1493','#ffffff','#00ff00'];
  var s=document.getElementById('swatches');
  presets.forEach(function(c){
    var b=document.createElement('span');b.className='swatch';b.style.background=c;
    b.onclick=function(){setColor(c);};s.appendChild(b);
  });
})();

function setColor(v){
  document.getElementById('cp').value=v;
  document.getElementById('picked').style.background=v;
  var r=parseInt(v.substr(1,2),16),g=parseInt(v.substr(3,2),16),b=parseInt(v.substr(5,2),16);
  cmd('rgb '+r+','+g+','+b);
}
function cmd(u){
  var x=new XMLHttpRequest();x.open('POST','/api/cmd',true);
  x.setRequestHeader('Content-Type','text/plain');x.send(u);
}
function markFx(e){
  document.querySelectorAll('.fx').forEach(function(b){b.classList.toggle('on',b.dataset.fx==e);});
}
function markAg(n){
  document.querySelectorAll('.agent').forEach(function(b){b.classList.toggle('on',b.dataset.ag==n);});
}
function loadState(){
  fetch('/api/state').then(function(r){return r.text();}).then(function(t){
    document.getElementById('status').textContent=t;
    try{
      var j=JSON.parse(t);
      document.getElementById('brt').value=j.led.brightness;
      document.getElementById('vBrt').textContent=j.led.brightness;
      document.getElementById('spd').value=j.led.speed;
      document.getElementById('vSpd').textContent=j.led.speed;
      markFx(j.current.effect);
      var hex='#'+[j.current.color.r,j.current.color.g,j.current.color.b]
        .map(function(x){return ('0'+(x|0).toString(16)).slice(-2);}).join('');
      document.getElementById('cp').value=hex;
      document.getElementById('picked').style.background=hex;
    }catch(e){}
  }).catch(function(){document.getElementById('status').textContent='获取失败';});
}
loadState();setInterval(loadState,5000);
</script>
</body>
</html>
)=====";

// AP 模式配置页 (WiFi + MQTT)
const char CONFIG_HTML[] PROGMEM = R"=====(
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>ESP32 Ring - 配置</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
     background:#0f172a;min-height:100vh;padding:16px;color:#e2e8f0}
.wrap{max-width:480px;margin:0 auto}
h1{font-size:20px;margin-bottom:12px}
.card{background:#1e293b;border:1px solid #334155;border-radius:12px;
      padding:14px;margin-bottom:12px}
.card h3{color:#38bdf8;font-size:14px;margin-bottom:10px}
label{display:block;font-size:12px;color:#94a3b8;margin:8px 0 4px}
input[type=text],input[type=password],input[type=number]{
  width:100%;padding:9px;border-radius:8px;border:1px solid #334155;
  background:#0f172a;color:#e2e8f0;font-size:14px}
.row{display:flex;gap:10px;align-items:center}
.btn{flex:1;padding:12px;border:none;border-radius:9px;cursor:pointer;
     font-size:14px;font-weight:600;background:#0ea5e9;color:#000}
.btn.off{background:#475569;color:#e2e8f0}
a{color:#38bdf8}
.hint{font-size:11px;color:#64748b;margin-top:6px}
</style>
</head>
<body>
<div class="wrap">
  <h1>⚙️ 配置 <a href="/" style="float:right;font-size:13px">←返回</a></h1>
  <form action="/save" method="POST">
    <div class="card">
      <h3>WiFi</h3>
      <label>SSID</label>
      <input type="text" name="ssid" maxlength="32" required>
      <label>密码</label>
      <input type="password" name="pass" maxlength="64">
    </div>
    <div class="card">
      <h3>MQTT (可选)</h3>
      <label>启用 MQTT</label>
      <div class="row">
        <label><input type="checkbox" name="mqen" value="1"> 启用</label>
      </div>
      <label>Broker 地址</label>
      <input type="text" name="mhost" placeholder="192.168.1.100">
      <label>端口</label>
      <input type="number" name="mport" value="1883">
      <label>用户名 (可选)</label>
      <input type="text" name="muser">
      <label>密码 (可选)</label>
      <input type="password" name="mpass">
      <label>主题前缀</label>
      <input type="text" name="mtopic" value="ring">
    </div>
    <button class="btn" type="submit">保存并重启</button>
    <p class="hint">保存后设备会重启并尝试连接新 WiFi。</p>
  </form>
</div>
</body>
</html>
)=====";

#endif // RING_WEB_INDEX_HTML_H
