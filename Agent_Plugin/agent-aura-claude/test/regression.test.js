'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { hooksSuppressed, loadConfig, loadRuntimeState, runtimeStatePath, saveConfig, suppressHooks } = require('../out/config');
const { parseDeviceState } = require('../out/deviceClient');
const { mapClaudeEventToAgentState, payloadContainsAgentAuraCommand, shouldSkipClaudeHook } = require('../out/hooks');

const ENV_KEYS = [
  'CLAUDE_HOME',
  'CLAUDE_PLUGIN_DATA',
  'CLAUDE_PLUGIN_OPTION_ENABLED',
  'CLAUDE_PLUGIN_OPTION_TRANSPORT',
  'CLAUDE_PLUGIN_OPTION_HOST',
  'CLAUDE_PLUGIN_OPTION_PORT',
  'CLAUDE_PLUGIN_OPTION_AUTO_DISCOVER',
  'CLAUDE_PLUGIN_OPTION_AUTH_TOKEN',
  'AGENTAURA_CLAUDE_CONFIG',
  'AGENTAURA_CLAUDE_STATE',
  'AGENTAURA_CLAUDE_HOST',
  'AGENTAURA_CLAUDE_PORT',
  'AGENTAURA_CLAUDE_AUTO_DISCOVER',
  'AGENTAURA_CLAUDE_TRANSPORT',
  'AGENTAURA_CLAUDE_ENABLED',
  'AGENTAURA_CLAUDE_AUTH_TOKEN',
  'AGENTAURA_CLAUDE_DEBUG',
  'AGENTAURA_DEBUG',
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

function withTempClaudeHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-claude-test-'));
  try {
    process.env.CLAUDE_HOME = dir;
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('saveConfig does not persist temporary environment overrides', () => {
  withIsolatedEnv(() => withTempClaudeHome((claudeHome) => {
    process.env.AGENTAURA_CLAUDE_HOST = 'env-host';
    process.env.AGENTAURA_CLAUDE_PORT = '1234';
    process.env.AGENTAURA_CLAUDE_AUTO_DISCOVER = 'false';

    const saved = saveConfig({ transport: 'http', host: 'file-host' });
    assert.equal(saved.host, 'file-host');
    assert.equal(saved.port, 80);
    assert.equal(saved.autoDiscover, true);

    const persisted = JSON.parse(fs.readFileSync(path.join(claudeHome, 'agent-aura-claude.json'), 'utf8'));
    assert.equal(persisted.host, 'file-host');
    assert.equal(persisted.port, 80);
    assert.equal(persisted.autoDiscover, true);

    const loaded = loadConfig();
    assert.equal(loaded.host, 'env-host');
    assert.equal(loaded.port, 1234);
    assert.equal(loaded.autoDiscover, false);
  }));
});

test('udp transport defaults to firmware UDP port when omitted', () => {
  withIsolatedEnv(() => withTempClaudeHome((claudeHome) => {
    const saved = saveConfig({ transport: 'udp', host: '192.0.2.1' });
    assert.equal(saved.port, 8888);

    const persisted = JSON.parse(fs.readFileSync(path.join(claudeHome, 'agent-aura-claude.json'), 'utf8'));
    assert.equal(persisted.port, 8888);

    fs.writeFileSync(path.join(claudeHome, 'agent-aura-claude.json'), JSON.stringify({
      transport: 'udp',
      host: '192.0.2.2',
    }), 'utf8');

    const loaded = loadConfig();
    assert.equal(loaded.port, 8888);
  }));
});

test('plugin option defaults do not override saved CLI config', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    saveConfig({ transport: 'udp', host: '192.0.2.3', port: 8888, enabled: false });

    process.env.CLAUDE_PLUGIN_OPTION_ENABLED = 'true';
    process.env.CLAUDE_PLUGIN_OPTION_TRANSPORT = 'http';
    process.env.CLAUDE_PLUGIN_OPTION_PORT = '80';

    const loaded = loadConfig();
    assert.equal(loaded.enabled, false);
    assert.equal(loaded.transport, 'udp');
    assert.equal(loaded.port, 8888);
  }));
});

test('plugin option auth token overrides config', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    saveConfig({ transport: 'http', host: '192.0.2.4', authToken: 'file-token' });

    process.env.CLAUDE_PLUGIN_OPTION_AUTH_TOKEN = 'plugin-token';

    const loaded = loadConfig();
    assert.equal(loaded.authToken, 'plugin-token');
  }));
});

test('plugin data directory is used for runtime state when provided', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    const pluginData = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-claude-data-'));
    try {
      process.env.CLAUDE_PLUGIN_DATA = pluginData;
      assert.equal(runtimeStatePath(), path.join(pluginData, 'state.json'));
    } finally {
      fs.rmSync(pluginData, { recursive: true, force: true });
    }
  }));
});

test('invalid config warnings are debug gated', () => {
  withIsolatedEnv(() => withTempClaudeHome((claudeHome) => {
    fs.writeFileSync(path.join(claudeHome, 'agent-aura-claude.json'), '{not json', 'utf8');

    const originalWrite = process.stderr.write;
    const writes = [];
    process.stderr.write = (chunk, ...args) => {
      writes.push(String(chunk));
      return typeof args.at(-1) === 'function' ? args.at(-1)() : true;
    };

    try {
      loadConfig();
      assert.equal(writes.length, 0);

      process.env.AGENTAURA_CLAUDE_DEBUG = '1';
      loadConfig();
      assert.equal(writes.length, 1);
      assert.match(writes[0], /failed to parse/);
    } finally {
      process.stderr.write = originalWrite;
    }
  }));
});

test('manual AgentAura slash command suppresses surrounding hooks', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    assert.equal(payloadContainsAgentAuraCommand({ prompt: '/agent-aura-claude:aura busy' }), true);
    assert.equal(payloadContainsAgentAuraCommand({ prompt: 'explain /agent-aura-claude:aura busy' }), false);
    assert.equal(shouldSkipClaudeHook('UserPromptSubmit', { prompt: '/agent-aura-claude:aura busy' }), true);
    assert.equal(hooksSuppressed(), true);
    assert.equal(shouldSkipClaudeHook('Stop', {}), true);
  }));
});

test('non-AgentAura user prompt clears manual hook suppression', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    suppressHooks(8000, 'test');
    assert.equal(hooksSuppressed(), true);
    assert.equal(shouldSkipClaudeHook('UserPromptSubmit', { prompt: 'normal request' }), false);
    assert.equal(hooksSuppressed(), false);
    assert.equal(loadRuntimeState().hookSuppressedUntil, undefined);
  }));
});

test('manual hook suppression expires', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    suppressHooks(1, 'test');
    assert.equal(hooksSuppressed(Date.now() + 10), false);
  }));
});

test('SessionStart clears stale hook suppression from previous session', () => {
  withIsolatedEnv(() => withTempClaudeHome(() => {
    suppressHooks(60000, 'stale from previous session');
    assert.equal(hooksSuppressed(), true);
    assert.equal(shouldSkipClaudeHook('SessionStart', {}), false);
    assert.equal(hooksSuppressed(), false);
    assert.equal(loadRuntimeState().hookSuppressedUntil, undefined);
  }));
});

test('Claude hook events map to firmware agent states', () => {
  assert.equal(mapClaudeEventToAgentState('SessionStart'), 'init');
  assert.equal(mapClaudeEventToAgentState('UserPromptSubmit'), 'running');
  assert.equal(mapClaudeEventToAgentState('PreToolUse'), 'busy');
  assert.equal(mapClaudeEventToAgentState('PermissionRequest'), 'waiting');
  assert.equal(mapClaudeEventToAgentState('PostToolUse'), 'running');
  assert.equal(mapClaudeEventToAgentState('PostToolUseFailure'), 'error');
  assert.equal(mapClaudeEventToAgentState('Stop'), 'idle');
  assert.equal(mapClaudeEventToAgentState('SessionEnd'), 'offline');
});

test('Claude payload signals can refine hook state', () => {
  assert.equal(mapClaudeEventToAgentState('Notification', { notification_type: 'permission_prompt' }), 'waiting');
  assert.equal(mapClaudeEventToAgentState('Notification', { notification_type: 'idle_prompt' }), 'idle');
  assert.equal(mapClaudeEventToAgentState('PostToolUse', { tool_response: { success: false } }), 'error');
});

test('Claude permission mode metadata does not force waiting state', () => {
  assert.equal(mapClaudeEventToAgentState('UserPromptSubmit', { permission_mode: 'ask' }), 'running');
  assert.equal(mapClaudeEventToAgentState('PreToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'busy');
  assert.equal(mapClaudeEventToAgentState('PostToolUse', { permission_mode: 'ask', tool_name: 'Bash' }), 'running');
  assert.equal(mapClaudeEventToAgentState('PermissionRequest', { permission_mode: 'ask' }), 'waiting');
});

test('device state parser waits for complete nested JSON object', () => {
  const parsed = parseDeviceState('boot log {"device":"ESP32-Ring","wifi":{"mode":"AP","ip":"192.168.4.1"},"led":{"agent":"busy"}} trailing');

  assert.equal(parsed.device, 'ESP32-Ring');
  assert.equal(parsed.wifi.mode, 'AP');
  assert.equal(parsed.led.agent, 'busy');
});

test('bundled Claude plugin hooks use node exec form', () => {
  const document = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8'));
  const userPromptHook = document.hooks.UserPromptSubmit[0].hooks[0];

  assert.equal(userPromptHook.type, 'command');
  assert.equal(userPromptHook.command, 'node');
  assert.deepEqual(userPromptHook.args.slice(-2), ['hook', 'UserPromptSubmit']);
  assert.ok(userPromptHook.args[0].includes('${CLAUDE_PLUGIN_ROOT}/bin/agent-aura-claude.js'));
});
