const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, saveConfig } = require('../out/config');
const { buildKimiMessage, mapKimiEventToAgentState } = require('../out/hooks');
const { installKimiHooks, uninstallKimiHooks } = require('../out/installHooks');

const ENV_KEYS = [
  'KIMI_CODE_HOME',
  'KIMI_CODE_CONFIG',
  'AGENTAURA_KIMI_CODE_CONFIG',
  'AGENTAURA_KIMI_CODE_HOST',
  'AGENTAURA_KIMI_CODE_PORT',
  'AGENTAURA_KIMI_CODE_AUTO_DISCOVER',
  'AGENTAURA_KIMI_CODE_TRANSPORT',
  'AGENTAURA_KIMI_CODE_ENABLED',
  'AGENTAURA_KIMI_CODE_AUTH_TOKEN',
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

function withTempKimiHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-kimi-code-test-'));
  try {
    process.env.KIMI_CODE_HOME = dir;
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('saveConfig does not persist temporary environment overrides', () => {
  withIsolatedEnv(() => withTempKimiHome((kimiHome) => {
    process.env.AGENTAURA_KIMI_CODE_HOST = 'env-host';
    process.env.AGENTAURA_KIMI_CODE_PORT = '1234';
    process.env.AGENTAURA_KIMI_CODE_AUTO_DISCOVER = 'false';
    process.env.AGENTAURA_KIMI_CODE_AUTH_TOKEN = 'env-token';

    const saved = saveConfig({ transport: 'http', host: 'file-host' });
    assert.equal(saved.host, 'file-host');
    assert.equal(saved.port, 80);
    assert.equal(saved.autoDiscover, true);
    assert.equal(saved.authToken, '');

    const persisted = JSON.parse(fs.readFileSync(path.join(kimiHome, 'agent-aura-kimi-code.json'), 'utf8'));
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
  withIsolatedEnv(() => withTempKimiHome((kimiHome) => {
    const saved = saveConfig({ transport: 'udp', host: '192.0.2.1' });
    assert.equal(saved.port, 8888);

    const persisted = JSON.parse(fs.readFileSync(path.join(kimiHome, 'agent-aura-kimi-code.json'), 'utf8'));
    assert.equal(persisted.port, 8888);

    fs.writeFileSync(path.join(kimiHome, 'agent-aura-kimi-code.json'), JSON.stringify({
      transport: 'udp',
      host: '192.0.2.2',
    }), 'utf8');

    const loaded = loadConfig();
    assert.equal(loaded.port, 8888);
  }));
});

test('installKimiHooks appends a managed hook block to config.toml', () => {
  withIsolatedEnv(() => withTempKimiHome((kimiHome) => {
    const configToml = path.join(kimiHome, 'config.toml');
    fs.writeFileSync(configToml, '# existing\n\n[[hooks]]\nevent = "Notification"\ncommand = "echo keep"\n', 'utf8');

    installKimiHooks();

    const document = fs.readFileSync(configToml, 'utf8');
    assert.match(document, /BEGIN AGENTAURA_KIMI_CODE_HOOKS/);
    assert.match(document, /event = "SessionStart"/);
    assert.match(document, /event = "Stop"/);
    assert.match(document, /AGENTAURA_KIMI_CODE_HOOK=1/);
    assert.match(document, /event = "Notification"/);
  }));
});

test('installKimiHooks is idempotent and uninstall removes only the managed block', () => {
  withIsolatedEnv(() => withTempKimiHome((kimiHome) => {
    const configToml = path.join(kimiHome, 'config.toml');
    fs.writeFileSync(configToml, '# prelude\n', 'utf8');

    installKimiHooks();
    installKimiHooks();
    let document = fs.readFileSync(configToml, 'utf8');
    assert.equal((document.match(/BEGIN AGENTAURA_KIMI_CODE_HOOKS/g) || []).length, 1);

    uninstallKimiHooks();
    document = fs.readFileSync(configToml, 'utf8');
    assert.equal(document.trim(), '# prelude');
  }));
});

test('Kimi hook events map to stable agent states', () => {
  assert.equal(mapKimiEventToAgentState('SessionStart'), 'init');
  assert.equal(mapKimiEventToAgentState('UserPromptSubmit'), 'running');
  assert.equal(mapKimiEventToAgentState('PreToolUse', { tool_name: 'Bash' }), 'busy');
  assert.equal(mapKimiEventToAgentState('PermissionRequest', { tool_name: 'Bash' }), 'waiting');
  assert.equal(mapKimiEventToAgentState('PermissionResult', { permissionDecision: 'allow' }), 'running');
  assert.equal(mapKimiEventToAgentState('PostToolUseFailure', { tool_name: 'Bash' }), 'error');
  assert.equal(mapKimiEventToAgentState('Stop'), 'idle');
  assert.equal(mapKimiEventToAgentState('SessionEnd'), 'offline');
});

test('Kimi payload metadata can still infer waiting or error states', () => {
  assert.equal(mapKimiEventToAgentState('UnknownEvent', { approval_request: { pending: true } }), 'waiting');
  assert.equal(mapKimiEventToAgentState('UnknownEvent', { hookSpecificOutput: { permissionDecision: 'deny' } }), 'error');
  assert.equal(mapKimiEventToAgentState('UnknownEvent', { tool_response: { success: false } }), 'error');
});

test('buildKimiMessage builds bubble text for tool events', () => {
  const tool = { tool_name: 'Bash' };
  assert.deepEqual(buildKimiMessage('PreToolUse', 'busy', tool), { text: '正在运行 Bash', kind: 'activity' });
  assert.deepEqual(buildKimiMessage('PermissionRequest', 'waiting', tool), { text: 'Bash 等待授权', kind: 'warning', priority: 60 });
  assert.deepEqual(buildKimiMessage('PostToolUse', 'running', tool), { text: 'Bash 已完成', kind: 'success' });
  assert.deepEqual(buildKimiMessage('PostToolUse', 'running', { tool_name: 'Bash', success: false }), { text: 'Bash 执行出错', kind: 'error', priority: 80 });
  assert.deepEqual(buildKimiMessage('PostToolUse', 'running', { tool_name: 'Bash', success: false, error: 'command failed' }), { text: 'command failed', kind: 'error', priority: 80 });
  assert.deepEqual(buildKimiMessage('PostToolUseFailure', 'error', tool), { text: 'Bash 执行出错', kind: 'error', priority: 80 });
  assert.deepEqual(buildKimiMessage('Stop', 'idle'), { text: '任务已完成', kind: 'success' });
  assert.deepEqual(buildKimiMessage('PreToolUse', 'busy', {}), { text: '正在运行 工具', kind: 'activity' });
  assert.equal(buildKimiMessage('Unknown', 'running'), undefined);
  assert.equal(buildKimiMessage('SessionEnd', 'offline'), undefined);
  assert.deepEqual(buildKimiMessage('  PreToolUse  ', 'busy', tool), { text: '正在运行 Bash', kind: 'activity' });
});
