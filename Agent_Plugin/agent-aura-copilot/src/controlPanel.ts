/**
 * ControlPanelProvider - Sidebar WebView for Ring Light control.
 *
 * Provides a full control panel matching the firmware's web UI:
 * - Power on/off
 * - Brightness & speed sliders
 * - Color picker + presets
 * - 15 effects
 * - Agent states
 * - Live status display
 */

import * as vscode from 'vscode';
import { DeviceClient } from './deviceClient';

export class ControlPanelProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'agentAura.controlPanel';

    private _view?: vscode.WebviewView;
    private _client: DeviceClient;
    private _outputChannel: vscode.OutputChannel;
    private _pollTimer?: ReturnType<typeof setInterval>;

    constructor(client: DeviceClient, outputChannel: vscode.OutputChannel) {
        this._client = client;
        this._outputChannel = outputChannel;
    }

    resolveWebviewView(
        webviewView: vscode.WebviewView,
        _context: vscode.WebviewViewResolveContext,
        _token: vscode.CancellationToken
    ) {
        this._view = webviewView;

        webviewView.webview.options = {
            enableScripts: true,
        };

        webviewView.webview.html = this._getHtml();

        // Handle messages from the WebView
        webviewView.webview.onDidReceiveMessage(async (msg) => {
            switch (msg.type) {
                case 'cmd':
                    await this._client.sendRawCommand(msg.value);
                    break;
                case 'agent':
                    await this._client.sendAgentState(msg.value);
                    break;
                case 'refresh':
                    await this._sendState();
                    break;
            }
        });

        // Poll state when panel is visible
        webviewView.onDidChangeVisibility(() => {
            if (webviewView.visible) {
                this._startPolling();
            } else {
                this._stopPolling();
            }
        });

        if (webviewView.visible) {
            this._startPolling();
        }
    }

    private _startPolling() {
        this._stopPolling();
        this._sendState();
        this._pollTimer = setInterval(() => this._sendState(), 5000);
    }

    private _stopPolling() {
        if (this._pollTimer) {
            clearInterval(this._pollTimer);
            this._pollTimer = undefined;
        }
    }

    private async _sendState() {
        if (!this._view) { return; }
        // Always notify webview of connection status
        this._view.webview.postMessage({
            type: 'connection',
            value: this._client.connected,
            transport: this._client.transport,
        });
        const state = await this._client.getDeviceState();
        if (state) {
            this._view.webview.postMessage({ type: 'state', value: state });
        }
    }

    private _getHtml(): string {
        return /*html*/`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-sideBar-background);
    padding: 8px;
}
.card {
    background: var(--vscode-editor-background);
    border: 1px solid var(--vscode-panel-border);
    border-radius: 8px;
    padding: 10px;
    margin-bottom: 8px;
}
.card h3 {
    font-size: 12px;
    color: var(--vscode-textLink-foreground);
    margin-bottom: 8px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.5px;
}
.row {
    display: flex;
    gap: 4px;
    flex-wrap: wrap;
}
.btn {
    flex: 1;
    min-width: 60px;
    padding: 6px 4px;
    border: 1px solid var(--vscode-button-border, transparent);
    border-radius: 4px;
    cursor: pointer;
    font-size: 11px;
    font-weight: 500;
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    transition: 0.1s;
}
.btn:hover {
    background: var(--vscode-button-secondaryHoverBackground);
}
.btn.on {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
.btn.power-on { background: #166534; color: #fff; }
.btn.power-off { background: #7f1d1d; color: #fff; }
.btn.agent-running { border-color: #22c55e; }
.btn.agent-busy { border-color: #eab308; }
.btn.agent-waiting { border-color: #f59e0b; }
.btn.agent-error { border-color: #ef4444; }
.btn.agent-idle { border-color: #3b82f6; }
.btn.agent-init { border-color: #a855f7; }
.btn.agent-offline { border-color: #6b7280; }
.btn.agent-upgrade { border-color: #f97316; }

.slider-row {
    display: flex;
    align-items: center;
    gap: 6px;
    margin: 6px 0;
}
.slider-row label {
    font-size: 11px;
    min-width: 28px;
    color: var(--vscode-descriptionForeground);
}
.slider-row input[type=range] {
    flex: 1;
    height: 4px;
    accent-color: var(--vscode-textLink-foreground);
}
.slider-row .val {
    font-size: 11px;
    min-width: 24px;
    text-align: right;
    color: var(--vscode-textLink-foreground);
    font-weight: bold;
}

.color-section {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;
}
#picked {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    border: 2px solid var(--vscode-panel-border);
    background: #00ff00;
}
input[type=color] {
    width: 32px;
    height: 32px;
    border: none;
    cursor: pointer;
    border-radius: 4px;
}
.swatches {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
}
.swatch {
    width: 22px;
    height: 22px;
    border-radius: 4px;
    border: 1px solid var(--vscode-panel-border);
    cursor: pointer;
    transition: 0.1s;
}
.swatch:hover {
    transform: scale(1.2);
}

.status-box {
    font-family: var(--vscode-editor-font-family);
    font-size: 11px;
    background: var(--vscode-terminal-background, #0d1117);
    border-radius: 4px;
    padding: 6px;
    color: var(--vscode-terminal-foreground, #4ade80);
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-all;
    max-height: 120px;
    overflow-y: auto;
}
.conn-badge {
    display: inline-block;
    font-size: 10px;
    padding: 2px 6px;
    border-radius: 8px;
    margin-bottom: 6px;
}
.conn-badge.ok { background: #166534; color: #4ade80; }
.conn-badge.err { background: #7f1d1d; color: #fca5a5; }
</style>
</head>
<body>
<div id="connBadge" class="conn-badge err">● 未连接</div>

<div class="card">
    <h3>⚡ 电源</h3>
    <div class="row">
        <button class="btn power-on" onclick="cmd('power on')">💡 开</button>
        <button class="btn power-off" onclick="cmd('power off')">⚫ 关</button>
    </div>
</div>

<div class="card">
    <h3>🔆 亮度 / 速度</h3>
    <div class="slider-row">
        <label>亮度</label>
        <input type="range" id="brt" min="0" max="255" value="128"
            oninput="cmd('brightness '+this.value); byId('vBrt').textContent=this.value">
        <span class="val" id="vBrt">128</span>
    </div>
    <div class="slider-row">
        <label>速度</label>
        <input type="range" id="spd" min="0" max="255" value="128"
            oninput="cmd('speed '+this.value); byId('vSpd').textContent=this.value">
        <span class="val" id="vSpd">128</span>
    </div>
</div>

<div class="card">
    <h3>🎨 颜色</h3>
    <div class="color-section">
        <span id="picked"></span>
        <input type="color" id="cp" value="#00ff00" oninput="setColor(this.value)">
        <span style="font-size:11px;color:var(--vscode-descriptionForeground)">点击选色</span>
    </div>
    <div class="swatches" id="swatches"></div>
</div>

<div class="card">
    <h3>✨ 灯效 (15)</h3>
    <div class="row" id="fxRow"></div>
</div>

<div class="card">
    <h3>🤖 智能体状态</h3>
    <div class="row" id="agentRow"></div>
</div>

<div class="card">
    <h3>📊 设备状态 <button class="btn" style="flex:0;min-width:auto;padding:3px 8px;font-size:10px" onclick="refresh()">刷新</button></h3>
    <div class="status-box" id="status">等待连接...</div>
</div>

<script>
const vscode = acquireVsCodeApi();

const EFFECTS = ['solid','breath','flow','rainbow','gradient','blink','fire',
    'sparkle','cycle','meteor','bounce','wave','pulse','fade','random'];
const AGENTS = [
    {n:'running', l:'🟢 运行', c:'agent-running'},
    {n:'busy',    l:'🟡 忙碌', c:'agent-busy'},
    {n:'waiting', l:'🟡 等待', c:'agent-waiting'},
    {n:'error',   l:'🔴 错误', c:'agent-error'},
    {n:'idle',    l:'🔵 空闲', c:'agent-idle'},
    {n:'init',    l:'🟣 初始', c:'agent-init'},
    {n:'offline', l:'⚪ 离线', c:'agent-offline'},
    {n:'upgrade', l:'🟠 升级', c:'agent-upgrade'}
];
const PRESETS = ['#ff0000','#ff8c00','#ffff00','#00ff00','#00ffff',
    '#0050ff','#8a2be2','#ff1493','#ffffff','#ffd700'];

function byId(id) { return document.getElementById(id); }

// Build effect buttons
(function() {
    var fr = byId('fxRow');
    EFFECTS.forEach(function(e) {
        var b = document.createElement('button');
        b.className = 'btn';
        b.textContent = e;
        b.dataset.fx = e;
        b.onclick = function() { cmd('effect ' + e); markFx(e); };
        fr.appendChild(b);
    });

    var ar = byId('agentRow');
    AGENTS.forEach(function(a) {
        var b = document.createElement('button');
        b.className = 'btn ' + a.c;
        b.textContent = a.l;
        b.dataset.ag = a.n;
        b.onclick = function() { sendAgent(a.n); markAg(a.n); };
        ar.appendChild(b);
    });

    var sw = byId('swatches');
    PRESETS.forEach(function(c) {
        var s = document.createElement('span');
        s.className = 'swatch';
        s.style.background = c;
        s.onclick = function() { setColor(c); };
        sw.appendChild(s);
    });
})();

function setColor(v) {
    byId('cp').value = v;
    byId('picked').style.background = v;
    var r = parseInt(v.substr(1,2),16);
    var g = parseInt(v.substr(3,2),16);
    var b = parseInt(v.substr(5,2),16);
    cmd('rgb ' + r + ',' + g + ',' + b);
}

function cmd(value) {
    vscode.postMessage({ type: 'cmd', value: value });
}

function sendAgent(state) {
    vscode.postMessage({ type: 'agent', value: state });
}

function refresh() {
    vscode.postMessage({ type: 'refresh' });
}

function markFx(e) {
    document.querySelectorAll('[data-fx]').forEach(function(b) {
        b.classList.toggle('on', b.dataset.fx === e);
    });
}

function markAg(n) {
    document.querySelectorAll('[data-ag]').forEach(function(b) {
        b.classList.toggle('on', b.dataset.ag === n);
    });
}

// Receive state updates from extension
window.addEventListener('message', function(event) {
    var msg = event.data;
    if (msg.type === 'connection') {
        var badge = byId('connBadge');
        if (msg.value) {
            badge.className = 'conn-badge ok';
            badge.textContent = '● 已连接 (' + msg.transport + ')';
        } else {
            badge.className = 'conn-badge err';
            badge.textContent = '● 未连接';
        }
    }
    if (msg.type === 'state' && msg.value) {
        var s = msg.value;
        byId('connBadge').className = 'conn-badge ok';
        byId('connBadge').textContent = '● 已连接 (' + (s.wifi && s.wifi.ip || s.device || '?') + ')';

        if (s.led) {
            byId('brt').value = s.led.brightness;
            byId('vBrt').textContent = s.led.brightness;
            byId('spd').value = s.led.speed;
            byId('vSpd').textContent = s.led.speed;
        }
        if (s.current) {
            markFx(s.current.effect);
            if (s.current.color) {
                var hex = '#' + [s.current.color.r, s.current.color.g, s.current.color.b]
                    .map(function(x) { return ('0' + (x|0).toString(16)).slice(-2); }).join('');
                byId('cp').value = hex;
                byId('picked').style.background = hex;
            }
        }
        byId('status').textContent = JSON.stringify(s, null, 2);
    }
});

// Initial refresh
refresh();
</script>
</body>
</html>`;
    }
}
