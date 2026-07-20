'use strict';

import * as childProcess from 'node:child_process';
import * as crypto from 'node:crypto';
import * as dgram from 'node:dgram';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { isDisabled, loadRuntimeState, saveConfig, saveRuntimeState, type Config, type RuntimeState } from './config';
import { discoverFirst, type DiscoveredDevice } from './discovery';
import { SendContext } from './types';

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

export interface DeviceState {
  reachable: boolean;
  raw?: string;
  [key: string]: unknown;
}

export interface DeviceDescriptor {
  transport: string;
  host: string;
  port: number;
  serialPort: string;
  baud: number;
  configured: boolean;
}

export class RingLightClient {
  config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  get isConfigured(): boolean {
    if (this.config.transport === 'serial') {
      return this.config.serialPort.length > 0;
    }
    return this.config.host.length > 0;
  }

  async sendAgentState(state: string, context?: SendContext): Promise<boolean> {
    if (!this.config.enabled || isDisabled()) {
      return true;
    }

    await this.maybeAutoDiscover();
    if (!this.isConfigured) {
      return false;
    }

    const now = Date.now();
    const runtime = loadRuntimeState();
    if (runtime.unreachableUntil && (runtime.unreachableUntil as number) > now) {
      return false;
    }
    if (runtime.lastState === state && runtime.lastSentAt && now - (runtime.lastSentAt as number) < this.config.debounceMs) {
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
      });
    } else {
      saveRuntimeState({
        ...latest,
        unreachableUntil: now + this.config.cooldownMs,
        lastError: `send ${state} failed`,
      });
    }
    return ok;
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
      const reRegistered = await this.registerPetDesktop(runtime.lastState || 'init', runtime.heartbeatIntervalMs || 10_000, false, context);
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
        return this.serialExchange(command, false).then((body) => {
          const trimmed = body === null ? '' : body.trim();
          return body !== null && (trimmed === '' || trimmed.startsWith('OK') || trimmed.startsWith('{'));
        });
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

  describe(): DeviceDescriptor {
    return {
      transport: this.config.transport,
      host: this.config.host,
      port: this.config.port,
      serialPort: this.config.serialPort,
      baud: this.config.baud,
      configured: this.isConfigured,
    };
  }

  async maybeAutoDiscover(): Promise<void> {
    if (this.isConfigured || !this.config.autoDiscover || this.config.transport === 'serial') {
      return;
    }

    const now = Date.now();
    const runtime = loadRuntimeState();
    if (runtime.discoveryRetryAfter && (runtime.discoveryRetryAfter as number) > now) {
      return;
    }

    const found = await discoverFirst(Math.max(this.config.timeoutMs, 900));
    if (!found?.ip) {
      saveRuntimeState({
        ...runtime,
        discoveryRetryAfter: now + this.config.cooldownMs,
        lastError: 'discover failed',
      });
      return;
    }

    this.config = saveConfig({
      transport: 'http',
      host: found.ip,
      port: (found.http as number) || 80,
    });
    saveRuntimeState({
      ...runtime,
      discoveryRetryAfter: 0,
      lastError: undefined,
    });
  }

  httpPost(requestPath: string, body: string, context?: SendContext): Promise<boolean> {
    return new Promise((resolve) => {
      const headers: Record<string, string | number> = {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      };
      const sessionId = context?.sessionId || (loadRuntimeState().lastSessionId as string | undefined);
      if (sessionId) headers['x-agentaura-session'] = sessionId;
      if (this.config.authToken) {
        headers.authorization = `Bearer ${this.config.authToken}`;
      }
      const req = http.request({
        hostname: this.config.host,
        port: this.portFor('http'),
        path: requestPath,
        method: 'POST',
        timeout: this.config.timeoutMs,
        headers,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => {
          const okStatus = (res.statusCode || 0) >= 200 && (res.statusCode || 0) < 300;
          const trimmed = data.trim();
          resolve(okStatus && (
            requestPath.startsWith('/api/agent')
            || trimmed === ''
            || trimmed.startsWith('OK')
            || trimmed.startsWith('{')
          ));
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

  httpGetJson(requestPath: string): Promise<DeviceState | null> {
    return new Promise((resolve) => {
      const headers: Record<string, string> = {};
      if (this.config.authToken) {
        headers.authorization = `Bearer ${this.config.authToken}`;
      }
      const req = http.get({
        hostname: this.config.host,
        port: this.portFor('http'),
        path: requestPath,
        timeout: Math.max(this.config.timeoutMs, 1200),
        headers,
      }, (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => {
          data += chunk.toString();
        });
        res.on('end', () => resolve(parseDeviceState(data)));
      });
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
    });
  }

  udpExchange(command: string, timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;

      const finish = (value: string | null) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          socket.close();
        } catch {
          // Ignore close errors.
        }
        resolve(value);
      };

      const timer = setTimeout(() => finish(null), timeoutMs);
      timer.unref?.();

      socket.on('error', () => finish(null));
      socket.on('message', (message: Buffer) => finish(message.toString('utf8').trim()));
      socket.send(Buffer.from(`${command}\n`, 'utf8'), this.portFor('udp'), this.config.host, (error?: Error | null) => {
        if (error) {
          finish(null);
        }
      });
    });
  }

  serialExchange(command: string, waitForJson: boolean): Promise<string | null> {
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
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        try {
          serial.off('data', onData);
        } catch {
          // Ignore listener cleanup errors.
        }
        try {
          serial.close();
        } catch {
          // Ignore close errors.
        }
        resolve(value);
      };

      const onData = (data: Buffer) => {
        buffer += data.toString('utf8');
        if (waitForJson) {
          const json = extractJsonObject(buffer);
          if (json) {
            finish(json);
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
      serial.open((openError?: Error) => {
        if (openError) {
          finish(null);
          return;
        }
        serial.write(`${command}\n`, (writeError?: Error) => {
          if (writeError) {
            finish(null);
          }
        });
      });
    });
  }

  portFor(transport: string): number {
    return this.config.port || (transport === 'udp' ? 8888 : 80);
  }

  private async sendHttpAgentState(state: string, runtime: RuntimeState, context?: SendContext): Promise<boolean> {
    if (runtime.httpTarget === 'firmware') {
      return await this.sendFirmwareState(state, context) || await this.sendPetDesktopState(state, runtime, context);
    }
    if (runtime.httpTarget === 'petdesktop') {
      return await this.sendPetDesktopState(state, runtime, context) || await this.sendFirmwareState(state, context);
    }
    return await this.sendPetDesktopState(state, runtime, context) || await this.sendFirmwareState(state, context);
  }

  private async sendPetDesktopState(state: string, runtime: RuntimeState, context?: SendContext): Promise<boolean> {
    const interval = clampHeartbeatInterval(runtime.heartbeatIntervalMs);
    const registered = await this.ensurePetDesktopRegistration(state, interval, runtime, context);
    if (!registered) {
      return false;
    }

    const instanceId = this.agentIdentity().instanceId;
    let result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/state`, { state }, context);
    if (!result.ok && result.statusCode === 404) {
      const reRegistered = await this.registerPetDesktop(state, interval, false, context);
      if (!reRegistered) {
        return false;
      }
      result = await this.httpJsonRequest('POST', `/api/v1/agents/${encodeURIComponent(instanceId)}/state`, { state }, context);
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

  private async sendFirmwareState(state: string, context?: SendContext): Promise<boolean> {
    const ok = await this.httpPost(`/api/agent?state=${encodeURIComponent(state)}`, '', context);
    if (!ok) {
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

  private async ensurePetDesktopRegistration(state: string, intervalMs: number, runtime: RuntimeState, context?: SendContext): Promise<boolean> {
    if (runtime.httpTarget === 'petdesktop' && runtime.petDesktopRegistered) {
      this.ensureHeartbeatProcess(intervalMs, runtime);
      return true;
    }
    return this.registerPetDesktop(state, intervalMs, true, context);
  }

  private async registerPetDesktop(state: string, intervalMs: number, allowSpawn: boolean, context?: SendContext): Promise<boolean> {
    const identity = this.agentIdentity();
    const result = await this.httpJsonRequest('POST', '/api/v1/agents/register', {
      clientId: 'claude',
      instanceId: identity.instanceId,
      displayName: 'Claude Code',
      state,
    }, context);
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

  private async disconnectPetDesktop(): Promise<void> {
    const instanceId = this.agentIdentity().instanceId;
    await this.httpJsonRequest('DELETE', `/api/v1/agents/${encodeURIComponent(instanceId)}`, undefined);
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

  private httpHeaders(context?: SendContext): http.OutgoingHttpHeaders {
    const identity = this.agentIdentity();
    const headers: http.OutgoingHttpHeaders = {
      'x-agentaura-client': 'claude',
      'x-agentaura-instance': identity.instanceId,
      'x-agentaura-name': 'Claude Code',
    };
    const sessionId = context?.sessionId || (loadRuntimeState().lastSessionId as string | undefined);
    if (sessionId) headers['x-agentaura-session'] = sessionId;
    if (this.config.authToken) {
      headers.authorization = `Bearer ${this.config.authToken}`;
    }
    return headers;
  }

  private agentIdentity(): { instanceId: string } {
    const override = process.env.AGENTAURA_CLAUDE_INSTANCE?.trim();
    if (override) {
      return { instanceId: override };
    }
    const host = os.hostname().trim().toLowerCase().replace(/[^a-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '') || 'local';
    return { instanceId: `claude-${host}`.slice(0, 128) };
  }
}

export function parseDeviceState(body: string | null): DeviceState | null {
  if (!body) {
    return null;
  }
  const json = extractJsonObject(body);
  if (!json) {
    return { reachable: true, raw: body.slice(0, 200) };
  }
  try {
    return JSON.parse(json) as DeviceState;
  } catch {
    return { reachable: true, raw: body.slice(0, 200) };
  }
}

export function extractJsonObject(body: string): string | null {
  const start = body.indexOf('{');
  if (start < 0) {
    return null;
  }

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < body.length; index += 1) {
    const character = body[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (character === '\\') {
        escaped = true;
      } else if (character === '"') {
        inString = false;
      }
      continue;
    }

    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{') {
      depth += 1;
      continue;
    }
    if (character === '}') {
      depth -= 1;
      if (depth === 0) {
        return body.slice(start, index + 1);
      }
    }
  }

  return null;
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
