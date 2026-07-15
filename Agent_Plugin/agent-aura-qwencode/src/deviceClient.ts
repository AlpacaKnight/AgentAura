import * as childProcess from 'child_process';
import * as crypto from 'crypto';
import * as dgram from 'dgram';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { isDisabled, loadRuntimeState, saveConfig, saveRuntimeState } from './config';
import { discoverFirst } from './discovery';
import { AgentAuraConfig, AgentState, DeviceState, RuntimeState, SendContext, TransportName } from './types';

const DEFAULT_PETDESKTOP_HEARTBEAT_MS = 10_000;
const MIN_PETDESKTOP_HEARTBEAT_MS = 500;
const MAX_PETDESKTOP_HEARTBEAT_MS = 60_000;
const PETDESKTOP_HEARTBEAT_IDLE_TTL_MS = 120_000;

interface JsonRequestResult {
    ok: boolean;
    statusCode: number;
    body: string;
    json?: any;
}

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
            ? await this.sendHttpAgentState(state, runtime, context)
            : await this.sendCommand(`agent ${state}`, context);

        const latest = loadRuntimeState();
        if (ok) {
            saveRuntimeState({
                ...latest,
                lastState: state,
                lastSentAt: now,
                lastActivityAt: now,
                unreachableUntil: 0,
                lastError: undefined,
                lastSessionId: context?.sessionId || latest.lastSessionId,
            });
        } else {
            saveRuntimeState({ ...latest, unreachableUntil: now + this.config.cooldownMs, lastError: `send ${state} failed` });
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
                return this.httpTextRequest('POST', '/api/cmd', command, 'text/plain', context).then((result) => result.ok && (result.body === '' || result.body.startsWith('OK') || result.body.startsWith('{')));
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

    /**
     * 发送桌宠气泡消息摘要到 PetDesktop。仅发往已注册的 PetDesktop Agent API，
     * 不回退固件（固件环形灯不支持文字消息）。
     */
    async sendMessage(
        text: string,
        kind: 'state' | 'activity' | 'success' | 'warning' | 'error' = 'activity',
        priority?: number,
        ttlMs?: number,
        context?: SendContext,
    ): Promise<boolean> {
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
        // 仅发往 PetDesktop Agent API。
        if (runtime.httpTarget !== 'petdesktop' || !runtime.petDesktopRegistered) {
            return false;
        }

        const instanceId = this.agentIdentity().instanceId;
        let result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/message`, {
            kind,
            text,
            priority,
            ttlMs,
        }, context);
        // 404 时尝试重新注册一次再发。
        if (!result.ok && result.statusCode === 404) {
            const reRegistered = await this.registerPetDesktop(runtime.lastState || 'init', runtime.heartbeatIntervalMs || 10_000, false);
            if (!reRegistered) {
                return false;
            }
            result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/message`, {
                kind,
                text,
                priority,
                ttlMs,
            }, context);
        }
        if (!result.ok) {
            return false;
        }

        // 刷新 lastActivityAt 以保持心跳活跃，不覆盖 lastState（消息不是状态转换）。
        const latest = loadRuntimeState();
        saveRuntimeState({
            ...latest,
            lastActivityAt: now,
        });
        return true;
    }

    async disconnectPetDesktop(): Promise<void> {
        const instanceId = this.agentIdentity().instanceId;
        await this.httpJsonRequest('DELETE', `/api/v1/agents/${encodeURIComponent(instanceId)}`, undefined);
    }

    async runHeartbeatLoop(token: string, intervalMs: number): Promise<void> {
        const interval = clampHeartbeatInterval(intervalMs);
        for (;;) {
            const runtime = loadRuntimeState();
            if (runtime.heartbeatToken !== token) {
                return;
            }
            if (!this.config.enabled || isDisabled() || this.config.transport !== 'http') {
                return;
            }
            if (runtime.httpTarget !== 'petdesktop' || !runtime.petDesktopRegistered) {
                return;
            }

            const lastActivityAt = runtime.lastActivityAt || runtime.lastSentAt || 0;
            if (lastActivityAt > 0 && Date.now() - lastActivityAt > PETDESKTOP_HEARTBEAT_IDLE_TTL_MS) {
                await this.disconnectPetDesktop();
                this.clearPetDesktopSession(token);
                return;
            }

            const heartbeatOk = await this.sendPetDesktopHeartbeat();
            if (!heartbeatOk) {
                const registered = await this.registerPetDesktop(runtime.lastState || 'init', interval, false);
                if (!registered) {
                    this.clearPetDesktopSession(token);
                    return;
                }
            }

            await delay(interval);
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

    private async sendHttpAgentState(state: AgentState, runtime: RuntimeState, context?: SendContext): Promise<boolean> {
        if (runtime.httpTarget === 'firmware') {
            return await this.sendFirmwareState(state, context) || await this.sendPetDesktopState(state, runtime);
        }
        if (runtime.httpTarget === 'petdesktop') {
            return await this.sendPetDesktopState(state, runtime) || await this.sendFirmwareState(state, context);
        }
        return await this.sendPetDesktopState(state, runtime) || await this.sendFirmwareState(state, context);
    }

    private async sendPetDesktopState(state: AgentState, runtime: RuntimeState): Promise<boolean> {
        const interval = clampHeartbeatInterval(runtime.heartbeatIntervalMs);
        const registered = await this.ensurePetDesktopRegistration(state, interval, runtime);
        if (!registered) {
            return false;
        }

        const instanceId = this.agentIdentity().instanceId;
        let result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/state`, { state });
        if (!result.ok && result.statusCode === 404) {
            const reRegistered = await this.registerPetDesktop(state, interval, false);
            if (!reRegistered) {
                return false;
            }
            result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/state`, { state });
        }
        if (!result.ok) {
            return false;
        }

        const latest = loadRuntimeState();
        saveRuntimeState({
            ...latest,
            httpTarget: 'petdesktop',
            petDesktopRegistered: true,
        });
        return true;
    }

    private async sendFirmwareState(state: AgentState, context?: SendContext): Promise<boolean> {
        const result = await this.httpTextRequest('POST', `/api/agent?state=${encodeURIComponent(state)}`, '', 'text/plain', context);
        if (!result.ok) {
            return false;
        }
        const latest = loadRuntimeState();
        saveRuntimeState({
            ...latest,
            httpTarget: 'firmware',
            petDesktopRegistered: false,
            heartbeatToken: undefined,
            heartbeatIntervalMs: undefined,
        });
        return true;
    }

    private async ensurePetDesktopRegistration(state: AgentState, intervalMs: number, runtime: RuntimeState): Promise<boolean> {
        if (runtime.httpTarget === 'petdesktop' && runtime.petDesktopRegistered) {
            this.ensureHeartbeatProcess(intervalMs, runtime);
            return true;
        }
        return this.registerPetDesktop(state, intervalMs, true);
    }

    private async registerPetDesktop(state: AgentState, intervalMs: number, allowSpawn: boolean): Promise<boolean> {
        const identity = this.agentIdentity();
        const result = await this.httpJsonRequest('POST', '/api/v1/agents/register', {
            clientId: 'qwen-code',
            instanceId: identity.instanceId,
            displayName: 'Qwen Code',
            state,
        });
        if (!result.ok) {
            return false;
        }

        const negotiatedInterval = clampHeartbeatInterval(result.json?.heartbeatIntervalMs || intervalMs);
        const latest = loadRuntimeState();
        const next: RuntimeState = {
            ...latest,
            httpTarget: 'petdesktop',
            petDesktopRegistered: true,
            heartbeatIntervalMs: negotiatedInterval,
        };
        saveRuntimeState(next);
        if (allowSpawn) {
            this.ensureHeartbeatProcess(negotiatedInterval, next);
        }
        return true;
    }

    private ensureHeartbeatProcess(intervalMs: number, runtime?: RuntimeState): void {
        const latest = runtime || loadRuntimeState();
        const normalizedInterval = clampHeartbeatInterval(intervalMs);
        if (latest.heartbeatToken && latest.heartbeatIntervalMs === normalizedInterval) {
            return;
        }

        const token = crypto.randomUUID();
        saveRuntimeState({
            ...latest,
            heartbeatToken: token,
            heartbeatIntervalMs: normalizedInterval,
        });

        const entry = path.resolve(__dirname, 'index.js');
        const child = childProcess.spawn(process.execPath || 'node', [entry, 'heartbeat-loop', token, String(normalizedInterval)], {
            detached: true,
            stdio: 'ignore',
        });
        child.unref();
    }

    private async sendPetDesktopHeartbeat(): Promise<boolean> {
        const instanceId = this.agentIdentity().instanceId;
        const result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/heartbeat`, undefined);
        return result.ok;
    }

    private clearPetDesktopSession(token: string): void {
        const latest = loadRuntimeState();
        if (latest.heartbeatToken !== token) {
            return;
        }
        saveRuntimeState({
            ...latest,
            petDesktopRegistered: false,
            heartbeatToken: undefined,
            heartbeatIntervalMs: undefined,
        });
    }

    private httpTextRequest(method: string, requestPath: string, body: string, contentType: string, context?: SendContext): Promise<JsonRequestResult> {
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.config.host,
                port: this.portFor('http'),
                path: requestPath,
                method,
                timeout: this.config.timeoutMs,
                headers: {
                    ...this.httpHeaders(context),
                    'Content-Type': contentType,
                    'Content-Length': Buffer.byteLength(body),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => resolve({
                    ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
                    statusCode: res.statusCode || 0,
                    body: data.trim(),
                }));
            });
            req.on('error', () => resolve({ ok: false, statusCode: 0, body: '' }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, statusCode: 0, body: '' });
            });
            if (body.length > 0) {
                req.write(body);
            }
            req.end();
        });
    }

    private httpJsonRequest(method: string, requestPath: string, body?: unknown, context?: SendContext): Promise<JsonRequestResult> {
        const text = body === undefined ? '' : JSON.stringify(body);
        return new Promise((resolve) => {
            const req = http.request({
                hostname: this.config.host,
                port: this.portFor('http'),
                path: requestPath,
                method,
                timeout: Math.max(this.config.timeoutMs, 1200),
                headers: {
                    ...this.httpHeaders(context),
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(text),
                },
            }, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk.toString());
                res.on('end', () => {
                    const bodyText = data.trim();
                    let json: any;
                    if (bodyText) {
                        try {
                            json = JSON.parse(bodyText);
                        } catch {
                            json = undefined;
                        }
                    }
                    resolve({
                        ok: (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300,
                        statusCode: res.statusCode || 0,
                        body: bodyText,
                        json,
                    });
                });
            });
            req.on('error', () => resolve({ ok: false, statusCode: 0, body: '' }));
            req.on('timeout', () => {
                req.destroy();
                resolve({ ok: false, statusCode: 0, body: '' });
            });
            if (text.length > 0) {
                req.write(text);
            }
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

function clampHeartbeatInterval(value: unknown): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) {
        return DEFAULT_PETDESKTOP_HEARTBEAT_MS;
    }
    return Math.min(MAX_PETDESKTOP_HEARTBEAT_MS, Math.max(MIN_PETDESKTOP_HEARTBEAT_MS, Math.round(n)));
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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
