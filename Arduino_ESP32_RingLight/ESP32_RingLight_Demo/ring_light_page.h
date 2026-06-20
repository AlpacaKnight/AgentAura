/*
 *  ring_light_page.h
 *  WS2812 环形灯控制面板网页 (PROGMEM, 存入 Flash 节省 RAM)
 *  被 ESP32_RingLight.ino 通过 extern 引用
 *  不修改本文件即可使用；要换皮肤直接改这里的 HTML/CSS/JS
 */
#ifndef RING_LIGHT_PAGE_H
#define RING_LIGHT_PAGE_H

const char PAGE_HTML[] PROGMEM = R"=====(
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>WS2812 环形灯控制器</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  body{font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
       background:linear-gradient(135deg,#1a1a2e,#16213e);min-height:100vh;
       padding:18px;color:#eee}
  .wrap{max-width:520px;margin:0 auto}
  h1{text-align:center;font-size:22px;margin-bottom:4px}
  .sub{text-align:center;color:#8a9;font-size:13px;margin-bottom:18px}

  .card{background:#1f2a44;border-radius:14px;padding:16px;margin-bottom:14px;
        box-shadow:0 4px 16px rgba(0,0,0,.3)}
  .card h3{font-size:15px;color:#7ec;margin-bottom:12px;font-weight:600}

  .row{display:flex;gap:10px;flex-wrap:wrap}
  .btn{flex:1;min-width:90px;padding:11px;border:none;border-radius:10px;
       cursor:pointer;font-size:14px;font-weight:600;background:#2d4373;color:#fff;
       transition:.15s}
  .btn:hover{background:#3a5398}
  .btn:active{transform:translateY(1px)}
  .btn.off{background:#555}
  .btn.eq{background:#2d4373}
  .btn.eq.on{background:#ff8c00;color:#000}

  .label{font-size:13px;color:#aab;margin:10px 0 6px}
  input[type=range]{width:100%;accent-color:#ff8c00}
  .val{float:right;color:#ff8c00;font-weight:bold}

  .ring{width:280px;height:280px;margin:0 auto;position:relative}
  .dot{position:absolute;width:30px;height:30px;border-radius:50%;
       transform:translate(-50%,-50%);cursor:pointer;border:2px solid #fff;
       background:#444;transition:.1s}
  .dot:hover{transform:translate(-50%,-50%) scale(1.15)}

  .swatch{display:inline-block;width:24px;height:24px;border-radius:6px;
          border:1px solid #fff;margin:3px;cursor:pointer}
  #picked{width:50px;height:50px;border-radius:8px;border:2px solid #fff;
          background:#0050ff;vertical-align:middle;margin-right:8px}
  .log{max-height:90px;overflow-y:auto;background:#0d0d0d;border-radius:8px;
       padding:8px;font:12px Consolas,monospace;color:#6f6;line-height:1.6}
</style>
</head>
<body>
<div class="wrap">
  <h1>🌈 WS2812 环形灯控制器</h1>
  <div class="sub">点击灯珠/按钮控制 24 颗灯珠</div>

  <!-- 开关 -->
  <div class="card">
    <h3>电源</h3>
    <div class="row">
      <button class="btn" onclick="cmd('/api/on')">开</button>
      <button class="btn off" onclick="cmd('/api/off')">关</button>
    </div>
  </div>

  <!-- 亮度 -->
  <div class="card">
    <h3>亮度 <span class="val" id="brtVal">60</span></h3>
    <input type="range" id="brt" min="5" max="255" value="60"
           oninput="cmd('/api/brightness?v='+this.value);document.getElementById('brtVal').textContent=this.value">
  </div>

  <!-- 颜色 -->
  <div class="card">
    <h3>颜色</h3>
    <div style="margin-bottom:10px">
      <span id="picked"></span>
      <input type="color" id="cp" value="#0050ff"
             oninput="setColor(this.value)">
    </div>
    <div id="swatches"></div>
    <button class="btn eq" style="margin-top:8px;width:100%"
            onclick="cmd('/api/effect?n=0')">应用为纯色</button>
  </div>

  <!-- 灯效 -->
  <div class="card">
    <h3>灯效</h3>
    <div class="row">
      <button class="btn eq" onclick="setEffect(0,this)">纯色</button>
      <button class="btn eq" onclick="setEffect(1,this)">彩虹</button>
      <button class="btn eq" onclick="setEffect(2,this)">呼吸</button>
      <button class="btn eq" onclick="setEffect(3,this)">跑马灯</button>
      <button class="btn eq" onclick="setEffect(4,this)">流水</button>
    </div>
  </div>

  <!-- 单灯编辑 -->
  <div class="card">
    <h3>单颗灯珠 (点击灯珠用当前颜色点亮)</h3>
    <div class="ring" id="ring"></div>
    <div class="row" style="margin-top:12px">
      <button class="btn off" onclick="cmd('/api/clear')">全部熄灭</button>
    </div>
  </div>

  <div class="card">
    <h3>日志</h3>
    <div class="log" id="log"></div>
  </div>
</div>

<script>
  var R=24,CX=140,CY=140,RAD=108;
  // 生成 24 颗灯珠围成一圈
  (function(){
    var ring=document.getElementById('ring');
    for(var i=0;i<R;i++){
      var a=(-90+i*360/R)*Math.PI/180;
      var d=document.createElement('div');
      d.className='dot';d.id='d'+i;
      d.style.left=(CX+RAD*Math.cos(a))+'px';
      d.style.top =(CY+RAD*Math.sin(a))+'px';
      d.title='灯珠 '+(i+1);
      d.onclick=(function(n){return function(){led(n);}})(i);
      ring.appendChild(d);
    }
  })();

  var presets=['#ff0000','#ff8c00','#ffff00','#00ff00','#00ffff',
               '#0050ff','#8a2be2','#ff1493','#ffffff','#0050ff'];
  (function(){
    var s=document.getElementById('swatches');
    presets.forEach(function(c){
      var b=document.createElement('span');b.className='swatch';
      b.style.background=c;b.onclick=function(){setColor(c);};
      s.appendChild(b);
    });
  })();

  function setColor(v){
    document.getElementById('cp').value=v;
    document.getElementById('picked').style.background=v;
    var r=parseInt(v.substr(1,2),16),
        g=parseInt(v.substr(3,2),16),
        b=parseInt(v.substr(5,2),16);
    cmd('/api/color?r='+r+'&g='+g+'&b='+b);
  }
  function led(i){
    var v=document.getElementById('cp').value;
    var r=parseInt(v.substr(1,2),16),
        g=parseInt(v.substr(3,2),16),
        b=parseInt(v.substr(5,2),16);
    cmd('/api/led?i='+i+'&r='+r+'&g='+g+'&b='+b);
    document.getElementById('d'+i).style.background=v;
  }
  function setEffect(n,btn){
    cmd('/api/effect?n='+n);
    var bs=document.querySelectorAll('.eq');
    for(var i=0;i<bs.length;i++)bs[i].classList.remove('on');
    btn.classList.add('on');
  }
  function cmd(u){
    var x=new XMLHttpRequest();
    x.open('GET',u,true);x.send();
    x.onload=function(){log(u+' -> '+x.status);};
    log(u);
  }
  function log(m){
    var b=document.getElementById('log');
    var t=new Date().toLocaleTimeString();
    b.innerHTML='<div>['+t+'] '+m+'</div>'+b.innerHTML;
  }
</script>
</body>
</html>
)=====";

#endif
