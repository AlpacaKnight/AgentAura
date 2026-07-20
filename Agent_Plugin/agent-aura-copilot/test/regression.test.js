const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

function loadDeviceClient() {
  const originalLoad = Module._load;
  Module._load = function(request, parent, isMain) {
    if (request === 'vscode') {
      return {
        env: { machineId: 'test-machine-id' },
        workspace: {
          getConfiguration: () => ({
            get: (key) => ({
              transport: 'http',
              host: '127.0.0.1',
              httpPort: 3030,
              udpPort: 8888,
              serialPort: '',
              serialBaud: 115200,
              authToken: '',
            })[key],
          }),
        },
        EventEmitter: class {
          event = () => {};
          fire() {}
          dispose() {}
        },
        window: { showErrorMessage() {} },
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  try {
    return require('../out/deviceClient').DeviceClient;
  } finally {
    Module._load = originalLoad;
  }
}

function outputChannel() {
  return { appendLine() {} };
}

test('Copilot package exposes PetDesktop v1 integration', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'deviceClient.ts'), 'utf8');
  assert.match(source, /\/api\/v1\/agents\/register/);
  assert.match(source, /\/heartbeat/);
  assert.match(source, /\/message/);
  assert.match(source, /clientId:\s*'copilot'/);
  assert.match(source, /process\.pid/);
  assert.match(source, /_sessionGeneration/);
  assert.match(source, /result\.status\s*===\s*404/);
});

test('Copilot transcript watcher emits bubble summaries', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'transcriptWatcher.ts'), 'utf8');
  assert.match(source, /sendMessage\(`正在运行/);
  assert.match(source, /等待操作授权/);
  assert.match(source, /任务已完成/);
});

test('Copilot discovery enumerates IPv4 adapter broadcasts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'discovery.ts'), 'utf8');
  assert.match(source, /networkInterfaces\(\)/);
  assert.match(source, /255\.255\.255\.255/);
  assert.match(source, /octet\s*&\s*mask\[index\].*~mask\[index\]/);
});

test('Copilot ignores a registration response from a disconnected session', async () => {
  const DeviceClient = loadDeviceClient();
  const client = new DeviceClient(outputChannel());
  client._connected = true;
  let complete;
  client._httpRequest = () => new Promise(resolve => { complete = resolve; });
  const generation = client._sessionGeneration;
  const pending = client._registerPetDesktop('idle', generation);
  client._connected = false;
  client._resetPetDesktopSession();
  complete({ ok: true, status: 200, json: { heartbeatIntervalMs: 10_000 } });
  assert.equal(await pending, false);
  assert.equal(client._httpTarget, 'unknown');
});

test('Copilot re-registers and retries a bubble after 404', async () => {
  const DeviceClient = loadDeviceClient();
  const client = new DeviceClient(outputChannel());
  client._connected = true;
  client._httpTarget = 'petdesktop';
  const calls = [];
  const responses = [
    { ok: false, status: 404 },
    { ok: true, status: 200, json: { heartbeatIntervalMs: 10_000 } },
    { ok: true, status: 200 },
  ];
  client._httpRequest = async (method, requestPath) => {
    calls.push([method, requestPath]);
    return responses.shift();
  };
  assert.equal(await client.sendMessage('完成', 'success'), true);
  client._resetPetDesktopSession();
  assert.equal(calls.filter(([, requestPath]) => requestPath.endsWith('/message')).length, 2);
  assert.ok(calls.some(([, requestPath]) => requestPath === '/api/v1/agents/register'));
});

test('Copilot keeps its heartbeat when unrelated config is reloaded', () => {
  const DeviceClient = loadDeviceClient();
  const client = new DeviceClient(outputChannel());
  client._connected = true;
  client._httpTarget = 'petdesktop';
  client._lastState = 'idle';
  client._startHeartbeat(10_000);
  const heartbeat = client._heartbeatTimer;
  const generation = client._sessionGeneration;
  client.reloadConfig();
  assert.equal(client._heartbeatTimer, heartbeat);
  assert.equal(client._sessionGeneration, generation);
  assert.equal(client._httpTarget, 'petdesktop');
  client._resetPetDesktopSession();
});

test('Copilot retries PetDesktop after a temporary registration failure', async () => {
  const DeviceClient = loadDeviceClient();
  const client = new DeviceClient(outputChannel());
  client._connected = true;
  const calls = [];
  let registrationAttempts = 0;
  client._httpRequest = async (_method, requestPath) => {
    calls.push(requestPath);
    if (requestPath === '/api/v1/agents/register') {
      registrationAttempts += 1;
      if (registrationAttempts === 1) return { ok: false, status: 0 };
      return { ok: true, status: 200, json: { heartbeatIntervalMs: 10_000 } };
    }
    return { ok: true, status: 200 };
  };
  assert.equal(await client.sendAgentState('running'), true);
  assert.equal(client._httpTarget, 'unknown');
  assert.equal(await client.sendAgentState('running'), true);
  assert.equal(registrationAttempts, 2);
  assert.equal(client._httpTarget, 'petdesktop');
  client._resetPetDesktopSession();
});
