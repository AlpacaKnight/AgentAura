const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
    assert.ok(document.hooks.PreToolUse);
    assert.ok(document.hooks.PermissionRequest);
    assert.ok(document.hooks.PostToolUse);
    assert.ok(document.hooks.PreCompact);
    assert.ok(document.hooks.PostCompact);
    assert.ok(document.hooks.SubagentStart);
    assert.ok(document.hooks.SubagentStop);
    assert.equal(document.hooks.Notification, undefined);
    assert.equal(document.hooks.PermissionDenied, undefined);
    assert.equal(document.hooks.SessionEnd, undefined);
  }));
});

test('Codex supported hook events map to stable agent states', () => {
  assert.equal(mapCodexEventToAgentState('SessionStart'), 'init');
  assert.equal(mapCodexEventToAgentState('PermissionRequest'), 'waiting');
  assert.equal(mapCodexEventToAgentState('PreToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'busy');
  assert.equal(mapCodexEventToAgentState('PostToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'running');
  assert.equal(mapCodexEventToAgentState('PreCompact'), 'busy');
  assert.equal(mapCodexEventToAgentState('PostCompact'), 'running');
  assert.equal(mapCodexEventToAgentState('SubagentStart'), 'busy');
  assert.equal(mapCodexEventToAgentState('SubagentStop'), 'running');
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
