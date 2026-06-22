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

export class DeviceClient implements vscode.Disposable {
    private _transport: Transport = 'http';
    private _host: string = '';
    private _httpPort: number = 80;
    private _udpPort: number = 8888;
    private _serialPort: string = '';
    private _serialBaud: number = 115200;
    private _connected: boolean = false;
    private _unreachableUntil: number = 0;
    private _serialHandle: any = null;
    private _outputChannel: vscode.OutputChannel;
    private _lastState: AgentState | null = null;

    private readonly _onDidChangeConnection = new vscode.EventEmitter<boolean>();
    readonly onDidChangeConnection = this._onDidChangeConnection.event;

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
        this._transport = config.get<Transport>('transport') || 'http';
        this._host = config.get<string>('host') || '';
        this._httpPort = config.get<number>('httpPort') || 80;
        this._udpPort = config.get<number>('udpPort') || 8888;
        this._serialPort = config.get<string>('serialPort') || '';
        this._serialBaud = config.get<number>('serialBaud') || 115200;
    }

    async connect(): Promise<void> {
        this.reloadConfig();
        this._outputChannel.appendLine(`[AgentAura] Connecting via ${this._transport}...`);
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
        this._connected = false;
        this._lastState = null;
        if (this._serialHandle) {
            try { this._serialHandle.close(); } catch { /* ignore */ }
            this._serialHandle = null;
        }
        this._onDidChangeConnection.fire(false);
    }

    /**
     * Send an agent state command to the device.
     * This is the primary API used by the CopilotWatcher.
     */
    async sendAgentState(state: AgentState): Promise<boolean> {
        if (state === this._lastState) {
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
        this._lastState = state;
        this._outputChannel.appendLine(`[AgentAura] State → ${state}`);

        let ok: boolean;
        if (this._transport === 'http') {
            ok = await this._httpPost(`/api/agent?state=${encodeURIComponent(state)}`, '');
        } else {
            ok = await this.sendRawCommand(`agent ${state}`);
        }
        if (!ok) {
            this._outputChannel.appendLine(`[AgentAura] State → ${state} FAILED (transport: ${this._transport}, host: ${this._host})`);
        }
        return ok;
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
            const req = http.get(
                `http://${this._host}:${this._httpPort}/api/state`,
                { timeout: 2000 },
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
    }

    // ─── Private Transport Methods ───────────────────────────────────

    private _httpPost(path: string, body: string): Promise<boolean> {
        return new Promise((resolve) => {
            const options: http.RequestOptions = {
                hostname: this._host,
                port: this._httpPort,
                path,
                method: 'POST',
                timeout: 2000,
                headers: {
                    'Content-Type': 'text/plain',
                    'Content-Length': Buffer.byteLength(body),
                },
            };

            const req = http.request(options, (res) => {
                // Consume response data to free up memory
                res.resume();
                resolve(res.statusCode === 200);
            });

            req.on('error', (err) => {
                this._markUnreachable();
                this._outputChannel.appendLine(`[AgentAura] HTTP error: ${err.message}`);
                resolve(false);
            });

            req.on('timeout', () => {
                req.destroy();
                this._markUnreachable();
                resolve(false);
            });

            req.write(body);
            req.end();
        });
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

    private _connectSerial(): Promise<void> {
        return new Promise(async (resolve) => {
            if (!this._serialPort) {
                vscode.window.showErrorMessage('AgentAura: Serial port not configured');
                resolve();
                return;
            }

            try {
                // Dynamic import to avoid hard dependency when not using serial
                const { SerialPort } = await import('serialport');
                this._serialHandle = new SerialPort({
                    path: this._serialPort,
                    baudRate: this._serialBaud,
                });

                this._serialHandle.on('open', () => {
                    this._connected = true;
                    this._onDidChangeConnection.fire(true);
                    this._outputChannel.appendLine(`[AgentAura] Serial connected: ${this._serialPort}`);
                    resolve();
                });

                this._serialHandle.on('error', (err: Error) => {
                    this._outputChannel.appendLine(`[AgentAura] Serial error: ${err.message}`);
                    this._connected = false;
                    this._onDidChangeConnection.fire(false);
                    resolve();
                });

                this._serialHandle.on('close', () => {
                    this._connected = false;
                    this._onDidChangeConnection.fire(false);
                });
            } catch (err: any) {
                this._outputChannel.appendLine(`[AgentAura] Failed to open serial: ${err.message}`);
                vscode.window.showErrorMessage(`AgentAura: Cannot open serial port - ${err.message}`);
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
}
