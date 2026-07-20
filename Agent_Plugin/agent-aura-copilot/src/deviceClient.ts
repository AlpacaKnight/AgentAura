/**
 * DeviceClient - Fire-and-forget transport client for the ESP32 Ring Light.
 *
 * Supports three connection modes matching the firmware API:
 *   - http: REST API (POST /api/cmd, POST /api/agent, GET /api/state)
 *   - udp:  Text commands to UDP port 8888
 *   - serial: USB CDC at 115200 baud
 *
 * Includes an unreachable cooldown to avoid blocking the main loop
 * when the device is offline.
 */

import * as vscode from 'vscode';
import * as http from 'http';
import * as dgram from 'dgram';
import { AgentState } from './stateMapper';

export type Transport = 'http' | 'udp' | 'serial';

export interface DeviceState {
    device: string;
    firmware: string;
    uptime: number;
    wifi: { connected: boolean; ssid: string; rssi: number; ip: string; mode: string };
    led: { num_leds: number; brightness: number; speed: number; power: boolean };
    current: { effect: string; color: { r: number; g: number; b: number }; color2?: { r: number; g: number; b: number } };
    connections: { usb: boolean; http: boolean; udp: boolean; mqtt: boolean; ble: boolean };
}

const UNREACHABLE_COOLDOWN_MS = 3000;
const PETDESKTOP_HEARTBEAT_MS = 10_000;
const PLUGIN_VERSION = '0.3.0';

export class DeviceClient implements vscode.Disposable {
    private _transport: Transport = 'http';
    private _host: string = '';
    private _httpPort: number = 80;
    private _udpPort: number = 8888;
    private _serialPort: string = '';
    private _serialBaud: number = 115200;
    private _authToken: string = '';
    private _connected: boolean = false;
    private _unreachableUntil: number = 0;
    private _serialHandle: any = null;
    private _outputChannel: vscode.OutputChannel;
    private _lastState: AgentState | null = null;
    private _httpTarget: 'unknown' | 'petdesktop' | 'firmware' = 'unknown';
    private _heartbeatTimer: NodeJS.Timeout | null = null;
    private _sessionGeneration = 0;
    private readonly _instanceId = `copilot-${vscode.env.machineId.slice(0, 12)}-${process.pid}`;

    private readonly _onDidChangeConnection = new vscode.EventEmitter<boolean>();
    readonly onDidChangeConnection = this._onDidChangeConnection.event;
    private readonly _onDidChangeState = new vscode.EventEmitter<AgentState | null>();
    readonly onDidChangeState = this._onDidChangeState.event;

    constructor(outputChannel: vscode.OutputChannel) {
        this._outputChannel = outputChannel;
        this.reloadConfig();
    }

    get connected(): boolean { return this._connected; }
    get transport(): Transport { return this._transport; }
    get host(): string { return this._host; }
    get lastState(): AgentState | null { return this._lastState; }

    reloadConfig() {
        const config = vscode.workspace.getConfiguration('agentAura');
        const nextTransport = config.get<Transport>('transport') || 'http';
        const nextHost = config.get<string>('host') || '';
        const nextHttpPort = config.get<number>('httpPort') || 80;
        const nextUdpPort = config.get<number>('udpPort') || 8888;
        const nextSerialPort = config.get<string>('serialPort') || '';
        const nextSerialBaud = config.get<number>('serialBaud') || 115200;
        const nextAuthToken = config.get<string>('authToken') || '';
        const connectionChanged =
            nextTransport !== this._transport ||
            nextHost !== this._host ||
            nextHttpPort !== this._httpPort ||
            nextUdpPort !== this._udpPort ||
            nextSerialPort !== this._serialPort ||
            nextSerialBaud !== this._serialBaud ||
            nextAuthToken !== this._authToken;

        this._transport = nextTransport;
        this._host = nextHost;
        this._httpPort = nextHttpPort;
        this._udpPort = nextUdpPort;
        this._serialPort = nextSerialPort;
        this._serialBaud = nextSerialBaud;
        this._authToken = nextAuthToken;
        if (connectionChanged) {
            this._resetPetDesktopSession();
            if (this._connected) {
                this._setLastState(null);
            }
        }
    }

    async connect(): Promise<void> {
        this.reloadConfig();
        this._resetPetDesktopSession();
        this._outputChannel.appendLine(`[AgentAura] Connecting via ${this._transport}...`);
        if (this._serialHandle || this._connected) {
            await this._closeSerialHandle();
            this._connected = false;
            this._setLastState(null);
            this._onDidChangeConnection.fire(false);
        }
        this._unreachableUntil = 0;
        if (this._transport === 'serial') {
            await this._connectSerial();
        } else {
            // HTTP/UDP are connectionless, just mark as connected if host is set
            if (this._host) {
                this._connected = true;
                this._onDidChangeConnection.fire(true);
                this._outputChannel.appendLine(`[AgentAura] Connected: ${this._transport}://${this._host}:${this._transport === 'http' ? this._httpPort : this._udpPort}`);
            } else {
                this._outputChannel.appendLine(`[AgentAura] ERROR: host is empty, cannot connect`);
            }
        }
    }

    disconnect() {
        if (this._httpTarget === 'petdesktop') {
            void this._httpRequest('DELETE', `/api/v1/agents/${encodeURIComponent(this._instanceId)}`);
        }
        this._resetPetDesktopSession();
        this._connected = false;
        this._setLastState(null);
        void this._closeSerialHandle();
        this._onDidChangeConnection.fire(false);
    }

    /**
     * Send an agent state command to the device.
     * This is the primary API used by the CopilotWatcher.
     */
    async sendAgentState(state: AgentState): Promise<boolean> {
        if (
            state === this._lastState &&
            !(this._transport === 'http' && this._httpTarget === 'unknown')
        ) {
            return true; // No-op if state hasn't changed
        }
        if (!this._connected) {
            this._outputChannel.appendLine(`[AgentAura] State → ${state} (skipped: not connected)`);
            return false;
        }
        if (this._isUnreachable()) {
            this._outputChannel.appendLine(`[AgentAura] State → ${state} (skipped: unreachable cooldown)`);
            return false;
        }
        this._outputChannel.appendLine(`[AgentAura] State → ${state}`);
        const generation = this._sessionGeneration;

        let ok: boolean;
        if (this._transport === 'http') {
            ok = await this._sendHttpAgentState(state, generation);
        } else {
            ok = await this.sendRawCommand(`agent ${state}`);
        }
        if (generation !== this._sessionGeneration || !this._connected) {
            return false;
        }
        if (ok) {
            this._setLastState(state);
        }
        if (!ok) {
            this._outputChannel.appendLine(`[AgentAura] State → ${state} FAILED (transport: ${this._transport}, host: ${this._host})`);
        }
        return ok;
    }

    async sendMessage(
        text: string,
        kind: 'activity' | 'success' | 'warning' | 'error' | 'state' = 'activity',
        priority?: number,
        ttlMs = 5000
    ): Promise<boolean> {
        if (!text.trim() || this._transport !== 'http' || !this._connected) { return false; }
        const generation = this._sessionGeneration;
        if (this._httpTarget === 'unknown') {
            await this._registerPetDesktop(this._lastState || 'running', generation);
        }
        if (
            generation !== this._sessionGeneration ||
            !this._connected ||
            this._httpTarget !== 'petdesktop'
        ) { return false; }
        let result = await this._httpRequest(
            'POST',
            `/api/v1/agents/${encodeURIComponent(this._instanceId)}/message`,
            JSON.stringify({ text: text.trim().slice(0, 500), kind, priority, ttlMs }),
            'application/json'
        );
        if (result.status === 404) {
            this._httpTarget = 'unknown';
            if (await this._registerPetDesktop(this._lastState || 'running', generation)) {
                result = await this._httpRequest(
                    'POST',
                    `/api/v1/agents/${encodeURIComponent(this._instanceId)}/message`,
                    JSON.stringify({ text: text.trim().slice(0, 500), kind, priority, ttlMs }),
                    'application/json'
                );
            }
        }
        return generation === this._sessionGeneration && this._connected && result.ok;
    }

    /**
     * Send a raw text command to the device.
     */
    async sendRawCommand(command: string): Promise<boolean> {
        if (!this._connected) { return false; }
        if (this._isUnreachable()) { return false; }

        try {
            switch (this._transport) {
                case 'http':
                    return await this._httpPost('/api/cmd', command);
                case 'udp':
                    return await this._udpSend(command);
                case 'serial':
                    return this._serialSend(command);
                default:
                    return false;
            }
        } catch (err: any) {
            this._markUnreachable();
            this._outputChannel.appendLine(`[AgentAura] Send failed: ${err.message}`);
            return false;
        }
    }

    /**
     * Query device state via HTTP GET /api/state or serial "state" command.
     */
    async getDeviceState(): Promise<DeviceState | null> {
        if (!this._connected) { return null; }
        if (this._isUnreachable()) { return null; }

        if (this._transport === 'serial') {
            return this._serialQuery('state');
        }

        return new Promise((resolve) => {
            const headers: http.OutgoingHttpHeaders = {};
            if (this._authToken) {
                headers.authorization = `Bearer ${this._authToken}`;
            }
            const req = http.get(
                `http://${this._host}:${this._httpPort}/api/state`,
                { timeout: 2000, headers },
                (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        try {
                            resolve(JSON.parse(data));
                        } catch {
                            resolve(null);
                        }
                    });
                }
            );
            req.on('error', () => {
                this._markUnreachable();
                resolve(null);
            });
            req.on('timeout', () => {
                req.destroy();
                this._markUnreachable();
                resolve(null);
            });
        });
    }

    dispose() {
        this.disconnect();
        this._onDidChangeConnection.dispose();
        this._onDidChangeState.dispose();
    }

    // ─── Private Transport Methods ───────────────────────────────────

    private _httpPost(path: string, body: string): Promise<boolean> {
        return this._httpRequest('POST', path, body, 'text/plain').then(result => result.ok);
    }

    private _httpRequest(
        method: string,
        path: string,
        body = '',
        contentType = 'application/json'
    ): Promise<{ ok: boolean; status: number; json?: any }> {
        return new Promise((resolve) => {
            const headers: http.OutgoingHttpHeaders = {
                'Content-Type': contentType,
                'Content-Length': Buffer.byteLength(body),
                'x-agentaura-client': 'copilot',
                'x-agentaura-instance': this._instanceId,
                'x-agentaura-display-name': 'GitHub Copilot',
            };
            if (this._authToken) {
                headers.authorization = `Bearer ${this._authToken}`;
            }
            const options: http.RequestOptions = {
                hostname: this._host,
                port: this._httpPort,
                path,
                method,
                timeout: 2000,
                headers,
            };

            const req = http.request(options, (res) => {
                let response = '';
                res.on('data', chunk => response += chunk);
                res.on('end', () => {
                    let json: any;
                    try { json = response ? JSON.parse(response) : undefined; } catch { /* text response */ }
                    const status = res.statusCode || 0;
                    resolve({ ok: status >= 200 && status < 300, status, json });
                });
            });

            req.on('error', (err) => {
                this._markUnreachable();
                this._outputChannel.appendLine(`[AgentAura] HTTP error: ${err.message}`);
                resolve({ ok: false, status: 0 });
            });

            req.on('timeout', () => {
                req.destroy();
                this._markUnreachable();
                resolve({ ok: false, status: 0 });
            });

            req.write(body);
            req.end();
        });
    }

    private async _sendHttpAgentState(
        state: AgentState,
        expectedGeneration = this._sessionGeneration
    ): Promise<boolean> {
        if (this._httpTarget === 'unknown') {
            await this._registerPetDesktop(state, expectedGeneration);
        }
        if (
            expectedGeneration !== this._sessionGeneration ||
            !this._connected ||
            this._transport !== 'http'
        ) {
            return false;
        }
        if (this._httpTarget === 'petdesktop') {
            let result = await this._httpRequest(
                'POST',
                `/api/v1/agents/${encodeURIComponent(this._instanceId)}/state`,
                JSON.stringify({ state }),
                'application/json'
            );
            if (result.status === 404) {
                this._httpTarget = 'unknown';
                if (await this._registerPetDesktop(state, expectedGeneration)) {
                    result = await this._httpRequest(
                        'POST',
                        `/api/v1/agents/${encodeURIComponent(this._instanceId)}/state`,
                        JSON.stringify({ state }),
                        'application/json'
                    );
                }
            }
            return (
                expectedGeneration === this._sessionGeneration &&
                this._connected &&
                result.ok
            );
        }
        return this._httpPost(`/api/agent?state=${encodeURIComponent(state)}`, '');
    }

    private async _registerPetDesktop(
        state: AgentState,
        expectedGeneration = this._sessionGeneration
    ): Promise<boolean> {
        const result = await this._httpRequest(
            'POST',
            '/api/v1/agents/register',
            JSON.stringify({
                instanceId: this._instanceId,
                clientId: 'copilot',
                displayName: 'GitHub Copilot',
                version: PLUGIN_VERSION,
                state,
            }),
            'application/json'
        );
        if (
            expectedGeneration !== this._sessionGeneration ||
            !this._connected ||
            this._transport !== 'http'
        ) {
            return false;
        }
        if (!result.ok) {
            this._httpTarget =
                result.status === 404 || result.status === 405
                    ? 'firmware'
                    : 'unknown';
            return false;
        }
        this._httpTarget = 'petdesktop';
        this._startHeartbeat(
            Number(result.json?.heartbeatIntervalMs) || PETDESKTOP_HEARTBEAT_MS,
            expectedGeneration
        );
        return true;
    }

    private _startHeartbeat(intervalMs: number, generation = this._sessionGeneration) {
        if (this._heartbeatTimer) { clearInterval(this._heartbeatTimer); }
        const interval = Math.max(3000, Math.min(30_000, intervalMs));
        this._heartbeatTimer = setInterval(() => {
            void this._httpRequest(
                'POST',
                `/api/v1/agents/${encodeURIComponent(this._instanceId)}/heartbeat`
            ).then(async result => {
                if (
                    generation !== this._sessionGeneration ||
                    !this._connected ||
                    this._transport !== 'http'
                ) {
                    return;
                }
                if (!result.ok) {
                    this._httpTarget = 'unknown';
                    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
                    this._heartbeatTimer = null;
                    await this._registerPetDesktop(this._lastState || 'idle', generation);
                }
            });
        }, interval);
        this._heartbeatTimer.unref?.();
    }

    private _resetPetDesktopSession() {
        this._sessionGeneration += 1;
        if (this._heartbeatTimer) {
            clearInterval(this._heartbeatTimer);
            this._heartbeatTimer = null;
        }
        this._httpTarget = 'unknown';
    }

    private _udpSend(command: string): Promise<boolean> {
        return new Promise((resolve) => {
            const client = dgram.createSocket('udp4');
            const message = Buffer.from(command + '\n');

            client.send(message, this._udpPort, this._host, (err) => {
                client.close();
                if (err) {
                    this._markUnreachable();
                    this._outputChannel.appendLine(`[AgentAura] UDP error: ${err.message}`);
                    resolve(false);
                } else {
                    resolve(true);
                }
            });
        });
    }

    private _serialSend(command: string): boolean {
        if (!this._serialHandle) { return false; }
        try {
            this._serialHandle.write(command + '\n');
            return true;
        } catch (err: any) {
            this._outputChannel.appendLine(`[AgentAura] Serial error: ${err.message}`);
            return false;
        }
    }

    /**
     * Send a command over serial and collect the JSON response.
     */
    private _serialQuery(command: string): Promise<DeviceState | null> {
        return new Promise((resolve) => {
            if (!this._serialHandle) { resolve(null); return; }

            let buffer = '';
            const timeout = setTimeout(() => {
                cleanup();
                resolve(null);
            }, 2000);

            const onData = (data: Buffer) => {
                buffer += data.toString();
                // Look for a complete JSON object (starts with '{', ends with '}')
                const start = buffer.indexOf('{');
                if (start === -1) { return; }
                const end = buffer.lastIndexOf('}');
                if (end <= start) { return; }
                const json = buffer.substring(start, end + 1);
                try {
                    const parsed = JSON.parse(json);
                    cleanup();
                    resolve(parsed);
                } catch {
                    // Incomplete JSON, keep buffering
                }
            };

            const cleanup = () => {
                clearTimeout(timeout);
                this._serialHandle?.off('data', onData);
            };

            this._serialHandle.on('data', onData);
            this._serialHandle.write(command + '\n');
        });
    }

    private async _connectSerial(): Promise<void> {
        if (!this._serialPort) {
            vscode.window.showErrorMessage('AgentAura: Serial port not configured');
            return;
        }

        try {
            // Dynamic import to avoid hard dependency when not using serial
            const { SerialPort } = await import('serialport');
            await new Promise<void>((resolve) => {
                let settled = false;
                const finish = () => {
                    if (settled) { return; }
                    settled = true;
                    resolve();
                };

                const serialHandle = new SerialPort({
                    path: this._serialPort,
                    baudRate: this._serialBaud,
                });

                serialHandle.on('open', () => {
                    this._serialHandle = serialHandle;
                    this._connected = true;
                    this._onDidChangeConnection.fire(true);
                    this._outputChannel.appendLine(`[AgentAura] Serial connected: ${this._serialPort}`);
                    finish();
                });

                serialHandle.on('error', (err: Error) => {
                    this._outputChannel.appendLine(`[AgentAura] Serial error: ${err.message}`);
                    try { serialHandle.destroy?.(); } catch { /* ignore */ }
                    if (this._serialHandle === serialHandle) {
                        this._serialHandle = null;
                        this._connected = false;
                        this._setLastState(null);
                        this._onDidChangeConnection.fire(false);
                    }
                    finish();
                });

                serialHandle.on('close', () => {
                    if (this._serialHandle === serialHandle) {
                        this._serialHandle = null;
                        this._connected = false;
                        this._setLastState(null);
                        this._onDidChangeConnection.fire(false);
                    }
                });
            });
        } catch (err: any) {
            this._outputChannel.appendLine(`[AgentAura] Failed to open serial: ${err.message}`);
            vscode.window.showErrorMessage(`AgentAura: Cannot open serial port - ${err.message}`);
        }
    }

    private _closeSerialHandle(): Promise<void> {
        return new Promise((resolve) => {
            const handle = this._serialHandle;
            this._serialHandle = null;
            if (!handle) {
                resolve();
                return;
            }

            try {
                if (handle.isOpen) {
                    handle.close(() => resolve());
                } else {
                    try { handle.destroy?.(); } catch { /* ignore */ }
                    resolve();
                }
            } catch {
                resolve();
            }
        });
    }

    private _isUnreachable(): boolean {
        return Date.now() < this._unreachableUntil;
    }

    private _markUnreachable() {
        this._unreachableUntil = Date.now() + UNREACHABLE_COOLDOWN_MS;
    }

    private _setLastState(state: AgentState | null) {
        if (state === this._lastState) { return; }
        this._lastState = state;
        this._onDidChangeState.fire(state);
    }
}
