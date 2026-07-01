'use strict';

const dgram = require('node:dgram');
const http = require('node:http');
const { isDisabled, loadRuntimeState, saveConfig, saveRuntimeState } = require('./config');
const { discoverFirst } = require('./discovery');

class RingLightClient {
  constructor(config) {
    this.config = config;
  }

  get isConfigured() {
    if (this.config.transport === 'serial') {
      return this.config.serialPort.length > 0;
    }
    return this.config.host.length > 0;
  }

  async sendAgentState(state) {
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

  async sendCommand(command) {
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

  async health() {
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

  describe() {
    return {
      transport: this.config.transport,
      host: this.config.host,
      port: this.config.port,
      serialPort: this.config.serialPort,
      baud: this.config.baud,
      configured: this.isConfigured,
    };
  }

  async maybeAutoDiscover() {
    if (this.isConfigured || !this.config.autoDiscover || this.config.transport === 'serial') {
      return;
    }

    const now = Date.now();
    const runtime = loadRuntimeState();
    if (runtime.discoveryRetryAfter && runtime.discoveryRetryAfter > now) {
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
      port: found.http || 80,
    });
    saveRuntimeState({
      ...runtime,
      discoveryRetryAfter: 0,
      lastError: undefined,
    });
  }

  httpPost(requestPath, body) {
    return new Promise((resolve) => {
      const headers = {
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
        res.on('data', (chunk) => {
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

  httpGetJson(requestPath) {
    return new Promise((resolve) => {
      const headers = {};
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
        res.on('data', (chunk) => {
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

  udpExchange(command, timeoutMs) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket('udp4');
      let settled = false;

      const finish = (value) => {
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
      socket.on('message', (message) => finish(message.toString('utf8').trim()));
      socket.send(Buffer.from(`${command}\n`, 'utf8'), this.portFor('udp'), this.config.host, (error) => {
        if (error) {
          finish(null);
        }
      });
    });
  }

  serialExchange(command, waitForJson) {
    return new Promise((resolve) => {
      let SerialPortConstructor;
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

      const finish = (value) => {
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

      const onData = (data) => {
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
      serial.open((openError) => {
        if (openError) {
          finish(null);
          return;
        }
        serial.write(`${command}\n`, (writeError) => {
          if (writeError) {
            finish(null);
          }
        });
      });
    });
  }

  portFor(transport) {
    return this.config.port || (transport === 'udp' ? 8888 : 80);
  }
}

function parseDeviceState(body) {
  if (!body) {
    return null;
  }
  const json = extractJsonObject(body);
  if (!json) {
    return { reachable: true, raw: body.slice(0, 200) };
  }
  try {
    return JSON.parse(json);
  } catch {
    return { reachable: true, raw: body.slice(0, 200) };
  }
}

function extractJsonObject(body) {
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

module.exports = {
  RingLightClient,
  extractJsonObject,
  parseDeviceState,
};
