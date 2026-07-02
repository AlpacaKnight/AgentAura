import * as dgram from 'dgram';
import * as http from 'http';
import * as os from 'os';
import { isDisabled, loadRuntimeState, saveConfig, saveRuntimeState } from './config';
import { discoverFirst } from './discovery';
import { AgentAuraConfig, AgentState, DeviceState, SendContext, TransportName } from './types';

export class RingLightClient {
    constructor(private config: AgentAuraConfig) {}

    get isConfigured(): boolean {
        if (this.config.transport === 'serial') {
            return this.config.serialPort.length > 0;
        }
        return this.config.host.length > 0;
    }

    async sendAgentState(state: AgentState, context?: SendContext): Promise<boolean> {
        if (!this.config.enabled || isDisabled()) {
            return true;
        }

        await this.maybeAutoDiscover();
        if (!this.isConfigured) {
            return false;
        }

        const now = Date.now();
        const runtime = loadRuntimeState();
        if (runtime.unreachableUntil && runtime.unreachableUntil > now) {
            return false;
        }
        if (runtime.lastState === state && runtime.lastSentAt && now - runtime.lastSentAt < this.config.debounceMs) {
            return true;
        }

        const ok = this.config.transport === 'http'
            ? await this.httpPost(`/api/agent?state=${encodeURIComponent(state)}`, '', context)
            : await this.sendCommand(`agent ${state}`, context);

        if (ok) {
            saveRuntimeState({
                ...runtime,
                lastState: state,
                lastSentAt: now,
                unreachableUntil: 0,
                lastError: undefined,
                lastSessionId: context?.sessionId || runtime.lastSessionId,
            });
        } else {
            saveRuntimeState({ ...runtime, unreachableUntil: now + this.config.cooldownMs, lastError: `send ${state} failed` });
        }
        return ok;
    }

    async sendCommand(command: string, context?: SendContext): Promise<boolean> {
        if (!this.config.enabled || isDisabled()) {
            return true;
        }

        await this.maybeAutoDiscover();
        if (!this.isConfigured) {
            return false;
        }

        switch (this.config.transport) {
            case 'http':
                return this.httpPost('/api/cmd', command, context);
            case 'udp': {
                const body = await this.udpExchange(command, this.config.timeoutMs);
                return body !== null && (body === '' || body.startsWith('OK') || body.startsWith('{'));
            }
            case 'serial':
                return this.serialExchange(command, false).then((body) => body !== null && body.trim().startsWith('OK'));
            default:
                return false;
        }
    }

    async health(): Promise<DeviceState | null> {
        await this.maybeAutoDiscover();
        if (!this.isConfigured) {
            return null;
        }
        switch (this.config.transport) {
            case 'http':
                return this.httpGetJson('/api/state');
            case 'udp': {
                const body = await this.udpExchange('state', Math.max(this.config.timeoutMs, 1200));
                return parseDeviceState(body);
            }
            case 'serial': {
                const body = await this.serialExchange('state', true);
                return parseDeviceState(body);
            }
            default:
                return null;
        }
    }

    describe(): Record<string, unknown> {
        return {
            transport: this.config.transport,
            host: this.config.host,
            port: this.config.port,
            serialPort: this.config.serialPort,
            baud: this.config.baud,
            configured: this.isConfigured,
            agentIdentity: this.agentIdentity(),
        };
    }

    private async maybeAutoDiscover(): Promise<void> {
        if (this.isConfigured || !this.config.autoDiscover || this.config.transport === 'serial') {
            return;
        }
        const found = await discoverFirst(Math.max(this.config.timeoutMs, 900));
        if (!found?.ip) {
            return;
        }
        const patch: Partial<AgentAuraConfig> = {
            host: found.ip,
        };

        if (this.config.transport === 'udp') {
            patch.port = found.udp || 8888;
        } else {
            patch.port = found.http || 80;
        }

        this.config = saveConfig(patch);
    }

    private httpPost(requestPath: string, body: string, context?: SendContext): Promise<boolean> {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.config.host,
                port: this.portFor('http'),
                path: requestPath,
                method: 'POST',
                timeout: this.config.timeoutMs,
                headers: {
                    ...this.httpHeaders(context),
                    'Content-Type': 'text/plain',
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    const okStatus = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
                    const trimmed = data.trim();
                    resolve(okStatus && (requestPath.startsWith('/api/agent') || trimmed === '' || trimmed.startsWith('OK') || trimmed.startsWith('{')));
                });
            });
            req.on('error', () => resolve(false));
            req.on('timeout', () => {
                req.destroy();
                resolve(false);
            });
            req.write(body);
            req.end();
        });
    }

    private httpGetJson(requestPath: string): Promise<DeviceState | null> {
        return new Promise((resolve) => {
            const req = http.get({
                hostname: this.config.host,
                port: this.portFor('http'),
                path: requestPath,
                timeout: Math.max(this.config.timeoutMs, 1200),
                headers: this.httpHeaders(),
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => resolve(parseDeviceState(data)));
            });
            req.on('error', () => resolve(null));
            req.on('timeout', () => {
                req.destroy();
                resolve(null);
            });
        });
    }

    private udpExchange(command: string, timeoutMs: number): Promise<string | null> {
        return new Promise((resolve) => {
            const socket = dgram.createSocket('udp4');
            let settled = false;

            const finish = (value: string | null) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                try { socket.close(); } catch { /* ignore */ }
                resolve(value);
            };

            const timer = setTimeout(() => finish(null), timeoutMs);
            timer.unref?.();

            socket.on('error', () => finish(null));
            socket.on('message', message => finish(message.toString('utf8').trim()));
            socket.send(Buffer.from(`${command}\n`, 'utf8'), this.portFor('udp'), this.config.host, (error) => {
                if (error) { finish(null); }
            });
        });
    }

    private serialExchange(command: string, waitForJson: boolean): Promise<string | null> {
        return new Promise((resolve) => {
            let SerialPortConstructor: any;
            try {
                const serialModule = require('serialport');
                SerialPortConstructor = serialModule.SerialPort || serialModule;
            } catch {
                resolve(null);
                return;
            }

            const serial = new SerialPortConstructor({
                path: this.config.serialPort,
                baudRate: this.config.baud,
                autoOpen: false,
            });
            let settled = false;
            let buffer = '';

            const finish = (value: string | null) => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                try { serial.off('data', onData); } catch { /* ignore */ }
                try { serial.close(); } catch { /* ignore */ }
                resolve(value);
            };

            const onData = (data: Buffer) => {
                buffer += data.toString('utf8');
                if (waitForJson) {
                    const start = buffer.indexOf('{');
                    const end = buffer.lastIndexOf('}');
                    if (start >= 0 && end > start) {
                        finish(buffer.slice(start, end + 1));
                    }
                    return;
                }
                if (buffer.includes('\n') || buffer.startsWith('OK') || buffer.startsWith('ERR')) {
                    finish(buffer);
                }
            };

            const timer = setTimeout(() => finish(null), Math.max(this.config.timeoutMs, 650));
            timer.unref?.();

            serial.on('data', onData);
            serial.on('error', () => finish(null));
            serial.open((openError: Error | null | undefined) => {
                if (openError) {
                    finish(null);
                    return;
                }
                serial.write(`${command}\n`, (writeError: Error | null | undefined) => {
                    if (writeError) { finish(null); }
                });
            });
        });
    }

    private httpHeaders(context?: SendContext): Record<string, string> {
        const identity = this.agentIdentity();
        const headers: Record<string, string> = {
            'x-agentaura-client': 'qwen-code',
            'x-agentaura-instance': identity.instanceId,
            'x-agentaura-name': 'Qwen Code',
        };
        const sessionId = context?.sessionId || loadRuntimeState().lastSessionId;
        if (sessionId) {
            headers['x-agentaura-session'] = sessionId;
        }
        if (this.config.authToken) {
            headers.authorization = `Bearer ${this.config.authToken}`;
        }
        return headers;
    }

    private agentIdentity(): { instanceId: string } {
        const override = process.env.AGENTAURA_QWENCODE_INSTANCE?.trim();
        if (override) {
            return { instanceId: override };
        }
        const host = os.hostname().trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
        return { instanceId: `qwen-code-${host}`.slice(0, 128) };
    }

    private portFor(transport: TransportName): number {
        if (transport === 'udp') {
            return this.config.port || 8888;
        }
        return this.config.port || 80;
    }
}

function parseDeviceState(body: string | null): DeviceState | null {
    if (!body) {
        return null;
    }
    try {
        return JSON.parse(body) as DeviceState;
    } catch {
        const trimmed = body.trim();
        if (!trimmed) {
            return null;
        }
        return { reachable: true, raw: trimmed };
    }
}
