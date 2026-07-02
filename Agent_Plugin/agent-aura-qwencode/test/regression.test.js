const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, saveConfig } = require('../out/config');
const { mapQwenEventToAgentState } = require('../out/hooks');
const { installQwenHooks, uninstallQwenHooks } = require('../out/installHooks');

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

function withTempQwenHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-qwencode-test-'));
  try {
    process.env.QWEN_CODE_HOME = dir;
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
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
    assert.equal(document.hooks.SessionStart[0].hooks[0].name, 'agent-aura-qwencode:SessionStart');
    assert.match(document.hooks.SessionStart[0].hooks[0].command, /AGENTAURA_QWENCODE_HOOK=1|set AGENTAURA_QWENCODE_HOOK=1/);
    assert.equal(document.hooks.Notification[0].hooks[0].name, 'keep-auth');
    assert.equal(document.hooks.Notification[1].matcher, 'permission_prompt');
    assert.equal(document.hooks.Notification[1].hooks[0].name, 'agent-aura-qwencode:Notification');
  }));
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
