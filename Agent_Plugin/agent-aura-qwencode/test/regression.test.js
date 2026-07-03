const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { loadConfig, saveConfig, loadRuntimeState, saveRuntimeState } = require('../out/config');
const { RingLightClient } = require('../out/deviceClient');
const { mapQwenEventToAgentState } = require('../out/hooks');
const { installQwenHooks, uninstallQwenHooks, buildHookCommand } = require('../out/installHooks');

const ENV_KEYS = [
  'QWEN_CODE_HOME',
  'QWEN_HOME',
  'QWEN_CODE_SETTINGS',
  'QWEN_SETTINGS_PATH',
  'AGENTAURA_QWENCODE_CONFIG',
  'AGENTAURA_QWENCODE_HOST',
  'AGENTAURA_QWENCODE_PORT',
  'AGENTAURA_QWENCODE_AUTO_DISCOVER',
  'AGENTAURA_QWENCODE_TRANSPORT',
  'AGENTAURA_QWENCODE_ENABLED',
  'AGENTAURA_QWENCODE_AUTH_TOKEN',
];

function withIsolatedEnv(fn) {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) {
    delete process.env[key];
  }
  const restore = () => {
    for (const key of ENV_KEYS) {
      const value = previous.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

function withTempQwenHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-qwencode-test-'));
  process.env.QWEN_CODE_HOME = dir;
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    const result = fn(dir);
    if (result && typeof result.then === 'function') {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

test('saveConfig does not persist temporary environment overrides', () => {
  withIsolatedEnv(() => withTempQwenHome((qwenHome) => {
    process.env.AGENTAURA_QWENCODE_HOST = 'env-host';
    process.env.AGENTAURA_QWENCODE_PORT = '1234';
    process.env.AGENTAURA_QWENCODE_AUTO_DISCOVER = 'false';
    process.env.AGENTAURA_QWENCODE_AUTH_TOKEN = 'env-token';

    const saved = saveConfig({ transport: 'http', host: 'file-host' });
    assert.equal(saved.host, 'file-host');
    assert.equal(saved.port, 80);
    assert.equal(saved.autoDiscover, true);
    assert.equal(saved.authToken, '');

    const persisted = JSON.parse(fs.readFileSync(path.join(qwenHome, 'agent-aura-qwencode.json'), 'utf8'));
    assert.equal(persisted.host, 'file-host');
    assert.equal(persisted.port, 80);
    assert.equal(persisted.autoDiscover, true);
    assert.equal(persisted.authToken, '');

    const loaded = loadConfig();
    assert.equal(loaded.host, 'env-host');
    assert.equal(loaded.port, 1234);
    assert.equal(loaded.autoDiscover, false);
    assert.equal(loaded.authToken, 'env-token');
  }));
});

test('udp transport defaults to firmware UDP port when omitted', () => {
  withIsolatedEnv(() => withTempQwenHome((qwenHome) => {
    const saved = saveConfig({ transport: 'udp', host: '192.0.2.1' });
    assert.equal(saved.port, 8888);

    const persisted = JSON.parse(fs.readFileSync(path.join(qwenHome, 'agent-aura-qwencode.json'), 'utf8'));
    assert.equal(persisted.port, 8888);

    fs.writeFileSync(path.join(qwenHome, 'agent-aura-qwencode.json'), JSON.stringify({
      transport: 'udp',
      host: '192.0.2.2',
    }), 'utf8');

    const loaded = loadConfig();
    assert.equal(loaded.port, 8888);
  }));
});

test('installQwenHooks appends managed hook entries to settings.json', () => {
  withIsolatedEnv(() => withTempQwenHome((qwenHome) => {
    const settingsJson = path.join(qwenHome, 'settings.json');
    fs.writeFileSync(settingsJson, JSON.stringify({
      hooks: {
        Notification: [
          {
            matcher: '^auth_success$',
            hooks: [{ type: 'command', command: 'echo keep', name: 'keep-auth', timeout: 5 }],
          },
        ],
      },
    }, null, 2), 'utf8');

    installQwenHooks();

    const document = JSON.parse(fs.readFileSync(settingsJson, 'utf8'));
    assert.ok(document.hooks.SessionStart);
    assert.ok(document.hooks.Stop);
    const managed = document.hooks.SessionStart[0].hooks[0];
    assert.equal(managed.name, 'agent-aura-qwencode:SessionStart');
    assert.equal(managed.timeout, 15000);
    assert.deepEqual(managed.env, { AGENTAURA_QWENCODE_HOOK: '1' });
    assert.equal(managed.shell, process.platform === 'win32' ? 'powershell' : 'bash');
    assert.equal(document.hooks.Notification[0].hooks[0].name, 'keep-auth');
    assert.equal(document.hooks.Notification[1].matcher, 'permission_prompt');
    assert.equal(document.hooks.Notification[1].hooks[0].name, 'agent-aura-qwencode:Notification');
  }));
});

test('buildHookCommand builds a PowerShell call for Windows with quoted paths', () => {
  const { command, shell } = buildHookCommand('SessionStart', {
    platform: 'win32',
    node: "C:\\Program Files\\nodejs\\node.exe",
    entry: "C:\\path with spaces\\o'brien\\index.js",
  });
  assert.equal(shell, 'powershell');
  assert.equal(
    command,
    "& 'C:\\Program Files\\nodejs\\node.exe' 'C:\\path with spaces\\o''brien\\index.js' hook 'SessionStart'",
  );
  assert.ok(!command.includes('set '));
  assert.ok(!command.includes('&&'));
  assert.ok(!command.includes('>nul'));
});

test('buildHookCommand builds a bash command for POSIX with quoted paths', () => {
  const { command, shell } = buildHookCommand('Stop', {
    platform: 'linux',
    node: '/usr/local/bin/node',
    entry: "/home/o'brien/my plugin/index.js",
  });
  assert.equal(shell, 'bash');
  assert.equal(
    command,
    "'/usr/local/bin/node' '/home/o'\\''brien/my plugin/index.js' hook 'Stop'",
  );
  assert.ok(!command.includes('/dev/null'));
  assert.ok(!command.includes('|| true'));
});

test('installQwenHooks is idempotent and uninstall removes only managed entries', () => {
  withIsolatedEnv(() => withTempQwenHome((qwenHome) => {
    const settingsJson = path.join(qwenHome, 'settings.json');
    fs.writeFileSync(settingsJson, JSON.stringify({ hooks: {} }, null, 2), 'utf8');

    installQwenHooks();
    installQwenHooks();
    let document = JSON.parse(fs.readFileSync(settingsJson, 'utf8'));
    assert.equal(document.hooks.SessionStart.length, 1);

    uninstallQwenHooks();
    document = JSON.parse(fs.readFileSync(settingsJson, 'utf8'));
    assert.deepEqual(document, {});
  }));
});

test('Qwen hook events map to stable agent states', () => {
  assert.equal(mapQwenEventToAgentState('SessionStart'), 'init');
  assert.equal(mapQwenEventToAgentState('UserPromptSubmit'), 'running');
  assert.equal(mapQwenEventToAgentState('PreToolUse', { tool_name: 'Bash' }), 'busy');
  assert.equal(mapQwenEventToAgentState('PermissionRequest', { tool_name: 'Bash' }), 'waiting');
  assert.equal(mapQwenEventToAgentState('PostToolUseFailure', { tool_name: 'Bash' }), 'error');
  assert.equal(mapQwenEventToAgentState('Notification', { type: 'permission_prompt' }), 'waiting');
  assert.equal(mapQwenEventToAgentState('Stop'), 'idle');
  assert.equal(mapQwenEventToAgentState('SessionEnd'), 'offline');
});

test('Qwen payload metadata can still infer waiting or error states', () => {
  assert.equal(mapQwenEventToAgentState('UnknownEvent', { approval_request: { pending: true } }), 'waiting');
  assert.equal(mapQwenEventToAgentState('UnknownEvent', { hookSpecificOutput: { permissionDecision: 'deny' } }), 'error');
  assert.equal(mapQwenEventToAgentState('UnknownEvent', { tool_response: { success: false } }), 'error');
});


test('http mode prefers PetDesktop registration and preserves firmware command path', async () => {
  await withIsolatedEnv(async () => withTempQwenHome(async () => {
    const events = [];
    const stateByInstance = new Map();
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => body += chunk.toString());
      req.on('end', () => {
        events.push({ method: req.method, url: req.url, body, headers: req.headers });
        if (req.url === '/api/v1/agents/register' && req.method === 'POST') {
          const payload = JSON.parse(body || '{}');
          stateByInstance.set(payload.instanceId, { state: payload.state });
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
          stateByInstance.get(instanceId).state = JSON.parse(body || '{}').state;
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
        if (req.url === '/api/cmd' && req.method === 'POST') {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('OK');
          return;
        }
        if (req.url.startsWith('/api/agent?state=') && req.method === 'POST') {
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
      autoDiscover: false,
      authToken: 'secret-token',
    });

    try {
      const ok = await client.sendAgentState('running', { sessionId: 'session-1' });
      assert.equal(ok, true);

      const registerEvent = events.find((event) => event.url === '/api/v1/agents/register');
      assert.ok(registerEvent, 'expected PetDesktop register request');
      assert.equal(registerEvent.headers.authorization, 'Bearer secret-token');
      assert.equal(registerEvent.headers['x-agentaura-client'], 'qwen-code');

      const runtime = loadRuntimeState();
      assert.equal(runtime.httpTarget, 'petdesktop');
      assert.equal(runtime.petDesktopRegistered, true);
      assert.equal(runtime.lastSessionId, 'session-1');
      assert.ok(runtime.heartbeatToken, 'expected heartbeat token after registration');

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
