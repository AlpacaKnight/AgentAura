const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');


const http = require('node:http');

const { RingLightClient } = require('../out/deviceClient');
const { loadRuntimeState, saveRuntimeState } = require('../out/config');
const { loadConfig, saveConfig } = require('../out/config');
const { mapCodexEventToAgentState, shouldArmIdleFallback } = require('../out/hooks');
const { installCodexHooks } = require('../out/installHooks');

const ENV_KEYS = [
  'CODEX_HOME',
  'CODEX_HOOKS_FILE',
  'AGENTAURA_CODEX_CONFIG',
  'AGENTAURA_CODEX_HOST',
  'AGENTAURA_CODEX_PORT',
  'AGENTAURA_CODEX_AUTO_DISCOVER',
  'AGENTAURA_CODEX_TRANSPORT',
  'AGENTAURA_CODEX_ENABLED',
  'AGENTAURA_CODEX_IDLE_FALLBACK_MS',
];

function withIsolatedEnv(fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  try {
    return fn();
  } finally {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function withTempCodexHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-codex-test-'));
  try {
    process.env.CODEX_HOME = dir;
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('saveConfig does not persist temporary environment overrides', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    process.env.AGENTAURA_CODEX_HOST = 'env-host';
    process.env.AGENTAURA_CODEX_PORT = '1234';
    process.env.AGENTAURA_CODEX_AUTO_DISCOVER = 'false';
    process.env.AGENTAURA_CODEX_IDLE_FALLBACK_MS = '9000';

    const saved = saveConfig({ transport: 'http', host: 'file-host' });
    assert.equal(saved.host, 'file-host');
    assert.equal(saved.port, 80);
    assert.equal(saved.autoDiscover, true);
    assert.equal(saved.idleFallbackMs, 5000);

    const persisted = JSON.parse(fs.readFileSync(path.join(codexHome, 'agent-aura-codex.json'), 'utf8'));
    assert.equal(persisted.host, 'file-host');
    assert.equal(persisted.port, 80);
    assert.equal(persisted.autoDiscover, true);
    assert.equal(persisted.idleFallbackMs, 5000);

    const loaded = loadConfig();
    assert.equal(loaded.host, 'env-host');
    assert.equal(loaded.port, 1234);
    assert.equal(loaded.autoDiscover, false);
    assert.equal(loaded.idleFallbackMs, 9000);
  }));
});

test('udp transport defaults to firmware UDP port when omitted', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const saved = saveConfig({ transport: 'udp', host: '192.0.2.1' });
    assert.equal(saved.port, 8888);

    const persisted = JSON.parse(fs.readFileSync(path.join(codexHome, 'agent-aura-codex.json'), 'utf8'));
    assert.equal(persisted.port, 8888);

    fs.writeFileSync(path.join(codexHome, 'agent-aura-codex.json'), JSON.stringify({
      transport: 'udp',
      host: '192.0.2.2',
    }), 'utf8');

    const loaded = loadConfig();
    assert.equal(loaded.port, 8888);
  }));
});

test('installCodexHooks refuses to overwrite invalid hooks JSON', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(hooksPath, '{ invalid json', 'utf8');

    assert.throws(() => installCodexHooks(), /Cannot read Codex hooks file/);
    assert.equal(fs.readFileSync(hooksPath, 'utf8'), '{ invalid json');
  }));
});

test('installCodexHooks replaces non-object hooks collections', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: [] }, null, 2), 'utf8');

    installCodexHooks();

    const document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.equal(Array.isArray(document.hooks), false);
    assert.ok(document.hooks.PreToolUse);
  }));
});

test('installCodexHooks writes hook commands with the current Node executable', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        PreToolUse: [
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }, null, 2), 'utf8');

    installCodexHooks();

    const document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const groups = document.hooks.PreToolUse;
    assert.equal(groups[0].hooks[0].command, 'echo keep-me');

    const installedHook = groups.flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes('AGENTAURA_CODEX_HOOK=1'));
    assert.ok(installedHook, 'expected AgentAura hook to be installed');
    assert.ok(installedHook.command.includes(process.execPath), installedHook.command);
  }));
});

test('installCodexHooks installs only Codex-supported hook events', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({ hooks: {} }, null, 2), 'utf8');

    installCodexHooks();

    const document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    assert.ok(document.hooks.SessionStart);
    assert.ok(document.hooks.UserPromptSubmit);
    assert.ok(document.hooks.PreToolUse);
    assert.ok(document.hooks.PermissionRequest);
    assert.ok(document.hooks.PostToolUse);
    assert.ok(document.hooks.PreCompact);
    assert.ok(document.hooks.PostCompact);
    assert.ok(document.hooks.SubagentStart);
    assert.ok(document.hooks.SubagentStop);
    assert.ok(document.hooks.Stop);
    assert.equal(document.hooks.PostToolUseFailure, undefined);
    assert.equal(document.hooks.StopFailure, undefined);
    assert.equal(document.hooks.SessionEnd, undefined);
    assert.equal(document.hooks.Notification, undefined);
    assert.equal(document.hooks.PermissionDenied, undefined);
  }));
});

test('Codex supported hook events map to stable agent states', () => {
  assert.equal(mapCodexEventToAgentState('SessionStart'), 'init');
  assert.equal(mapCodexEventToAgentState('UserPromptSubmit'), 'running');
  assert.equal(mapCodexEventToAgentState('PermissionRequest'), 'waiting');
  assert.equal(mapCodexEventToAgentState('PreToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'busy');
  assert.equal(mapCodexEventToAgentState('PostToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'running');
  assert.equal(mapCodexEventToAgentState('PreCompact'), 'busy');
  assert.equal(mapCodexEventToAgentState('PostCompact'), 'running');
  assert.equal(mapCodexEventToAgentState('SubagentStart'), 'busy');
  assert.equal(mapCodexEventToAgentState('SubagentStop'), 'running');
  assert.equal(mapCodexEventToAgentState('Stop'), 'idle');
});

test('idle fallback arms only after recoverable running states', () => {
  assert.equal(shouldArmIdleFallback('SessionStart', 'init'), true);
  assert.equal(shouldArmIdleFallback('PostToolUse', 'running'), true);
  assert.equal(shouldArmIdleFallback('PostCompact', 'running'), true);
  assert.equal(shouldArmIdleFallback('SubagentStop', 'running'), true);
  assert.equal(shouldArmIdleFallback('PreToolUse', 'busy'), false);
  assert.equal(shouldArmIdleFallback('PermissionRequest', 'waiting'), false);
  assert.equal(shouldArmIdleFallback('UnknownEvent', 'running'), false);
});

test('Codex permission mode metadata alone does not force waiting state', () => {
  assert.equal(mapCodexEventToAgentState('UnknownEvent', { permission_mode: 'ask' }), 'running');
  assert.equal(mapCodexEventToAgentState('UnknownEvent', { approval_request: { pending: true } }), 'waiting');
  assert.equal(mapCodexEventToAgentState('UnknownEvent', { tool_response: { success: false } }), 'error');
});


test('http mode uses PetDesktop register and heartbeat without breaking firmware commands', async () => {
  await withIsolatedEnv(async () => withTempCodexHome(async () => {
    const events = [];
    const stateByInstance = new Map();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk.toString());
      req.on('end', () => {
        events.push({ method: req.method, url: req.url, body, headers: req.headers });
        if (req.url === '/api/v1/agents/register' && req.method === 'POST') {
          const payload = JSON.parse(body || '{}');
          stateByInstance.set(payload.instanceId, { registered: true, state: payload.state });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, instanceId: payload.instanceId, heartbeatIntervalMs: 100 }));
          return;
        }
        const stateMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)\/state$/);
        if (stateMatch && req.method === 'POST') {
          const instanceId = decodeURIComponent(stateMatch[1]);
          if (!stateByInstance.has(instanceId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const heartbeatMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)\/heartbeat$/);
        if (heartbeatMatch && req.method === 'POST') {
          if (!stateByInstance.has(decodeURIComponent(heartbeatMatch[1]))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const deleteMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)$/);
        if (deleteMatch && req.method === 'DELETE') {
          stateByInstance.delete(decodeURIComponent(deleteMatch[1]));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.url === '/api/cmd' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, url: req.url }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');

    const client = new RingLightClient({
      enabled: true,
      transport: 'http',
      host: '127.0.0.1',
      port: address.port,
      serialPort: '',
      baud: 115200,
      debounceMs: 0,
      cooldownMs: 0,
      timeoutMs: 500,
      idleFallbackMs: 5000,
      autoDiscover: false,
      authToken: 'secret-token',
    });

    try {
      const ok = await client.sendAgentState('running');
      assert.equal(ok, true);

      const registerEvent = events.find((event) => event.url === '/api/v1/agents/register');
      assert.ok(registerEvent, 'expected PetDesktop register request');
      assert.equal(registerEvent.headers.authorization, 'Bearer secret-token');
      assert.equal(registerEvent.headers['x-agentaura-client'], 'codex');

      const stateEvent = events.find((event) => /\/api\/v1\/agents\/.*\/state$/.test(event.url));
      assert.ok(stateEvent, 'expected PetDesktop state request');
      assert.equal(JSON.parse(stateEvent.body).state, 'running');

      const commandOk = await client.sendCommand('rgb 1,2,3');
      assert.equal(commandOk, true);
      assert.ok(events.some((event) => event.url === '/api/cmd' && event.body === 'rgb 1,2,3'));
    } finally {
      const runtime = loadRuntimeState();
      if (runtime.heartbeatToken) {
        saveRuntimeState({ ...runtime, heartbeatToken: 'stop-test-heartbeat' });
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }));
});


test('PetDesktop heartbeat loop refreshes presence until the token changes', async () => {
  await withIsolatedEnv(async () => withTempCodexHome(async () => {
    const events = [];
    const stateByInstance = new Set();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk.toString());
      req.on('end', () => {
        events.push({ method: req.method, url: req.url, body, headers: req.headers });
        if (req.url === '/api/v1/agents/register' && req.method === 'POST') {
          const payload = JSON.parse(body || '{}');
          stateByInstance.add(payload.instanceId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, instanceId: payload.instanceId, heartbeatIntervalMs: 100 }));
          return;
        }
        const stateMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)\/state$/);
        if (stateMatch && req.method === 'POST') {
          const instanceId = decodeURIComponent(stateMatch[1]);
          if (!stateByInstance.has(instanceId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const heartbeatMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)\/heartbeat$/);
        if (heartbeatMatch && req.method === 'POST') {
          const instanceId = decodeURIComponent(heartbeatMatch[1]);
          if (!stateByInstance.has(instanceId)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false }));
            return;
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        const deleteMatch = req.url.match(/^\/api\/v1\/agents\/([^/]+)$/);
        if (deleteMatch && req.method === 'DELETE') {
          stateByInstance.delete(decodeURIComponent(deleteMatch[1]));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, url: req.url }));
      });
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.equal(typeof address, 'object');

    const client = new RingLightClient({
      enabled: true,
      transport: 'http',
      host: '127.0.0.1',
      port: address.port,
      serialPort: '',
      baud: 115200,
      debounceMs: 0,
      cooldownMs: 0,
      timeoutMs: 500,
      idleFallbackMs: 5000,
      autoDiscover: false,
      authToken: '',
    });

    try {
      const registered = await client.sendAgentState('running');
      assert.equal(registered, true);

      const runtime = loadRuntimeState();
      assert.ok(runtime.heartbeatToken, 'expected heartbeat token after registration');

      const loopPromise = client.runHeartbeatLoop(runtime.heartbeatToken, 100);
      await new Promise((resolve) => setTimeout(resolve, 650));
      saveRuntimeState({ ...loadRuntimeState(), heartbeatToken: 'stop-test-heartbeat-loop' });
      await Promise.race([
        loopPromise,
        new Promise((_, reject) => setTimeout(() => reject(new Error('heartbeat loop did not stop in time')), 1500)),
      ]);

      const heartbeatEvents = events.filter((event) => /\/api\/v1\/agents\/.*\/heartbeat$/.test(event.url));
      assert.ok(heartbeatEvents.length >= 1, 'expected PetDesktop heartbeat request');
    } finally {
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }));
});
