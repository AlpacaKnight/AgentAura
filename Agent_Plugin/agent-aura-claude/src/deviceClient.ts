'use strict';

import * as dgram from 'node:dgram';
import * as http from 'node:http';
import { isDisabled, loadRuntimeState, saveConfig, saveRuntimeState, type Config, type RuntimeState } from './config';
import { discoverFirst, type DiscoveredDevice } from './discovery';

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

  async sendAgentState(state: string): Promise<boolean> {
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
      ? await this.httpPost(`/api/agent?state=${encodeURIComponent(state)}`, '')
      : await this.sendCommand(`agent ${state}`);

    if (ok) {
      saveRuntimeState({
        ...runtime,
        lastState: state,
        lastSentAt: now,
        unreachableUntil: 0,
        discoveryRetryAfter: 0,
        lastError: undefined,
      });
    } else {
      saveRuntimeState({
        ...runtime,
        unreachableUntil: now + this.config.cooldownMs,
        lastError: `send ${state} failed`,
      });
    }
    return ok;
  }

  async sendCommand(command: string): Promise<boolean> {
    if (!this.config.enabled || isDisabled()) {
      return true;
    }

    await this.maybeAutoDiscover();
    if (!this.isConfigured) {
      return false;
    }

    switch (this.config.transport) {
      case 'http':
        return this.httpPost('/api/cmd', command);
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

  httpPost(requestPath: string, body: string): Promise<boolean> {
    return new Promise((resolve) => {
      const headers: Record<string, string | number> = {
        'Content-Type': 'text/plain',
        'Content-Length': Buffer.byteLength(body),
      };
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
