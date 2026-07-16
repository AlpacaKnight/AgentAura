const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, saveConfig, loadRuntimeState, saveRuntimeState } = require('../out/config');
const { RingLightClient } = require('../out/deviceClient');
const { buildZcodeMessage, mapZcodeEventToAgentState, ZCODE_HOOK_EVENTS, ZCODE_EVENT_TO_AGENT_STATE } = require('../out/hooks');
const { installZcodeHooks, uninstallZcodeHooks, buildHookCommand } = require('../out/installHooks');

const ENV_KEYS = [
  'ZCODE_HOME',
  'ZCODE_CODE_HOME',
  'ZCODE_CONFIG',
  'AGENTAURA_ZCODE_CONFIG',
  'AGENTAURA_ZCODE_HOST',
  'AGENTAURA_ZCODE_PORT',
  'AGENTAURA_ZCODE_AUTO_DISCOVER',
  'AGENTAURA_ZCODE_TRANSPORT',
  'AGENTAURA_ZCODE_ENABLED',
  'AGENTAURA_ZCODE_AUTH_TOKEN',
  'AGENTAURA_ZCODE_STATE',
  'ZCODE_PLUGIN_DATA',
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

function withTempZcodeHome(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-aura-zcode-test-'));
  process.env.ZCODE_HOME = dir;
  const cleanup = () => {
    fs.rmSync(dir, { recursive: true, force: true });
  };
  try {
    return fn(dir);
  } finally {
    cleanup();
  }
}

test('config defaults to http transport and empty host', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      const config = loadConfig();
      assert.equal(config.transport, 'http');
      assert.equal(config.host, '');
      assert.equal(config.port, 80);
      assert.equal(config.enabled, true);
      assert.equal(config.autoDiscover, true);
    });
  });
});

test('saveConfig persists and loadConfig reads back', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      saveConfig({ host: '192.168.1.50', port: 8080, transport: 'udp' });
      const config = loadConfig();
      assert.equal(config.host, '192.168.1.50');
      assert.equal(config.port, 8080);
      assert.equal(config.transport, 'udp');
    });
  });
});

test('environment overrides take effect', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      process.env.AGENTAURA_ZCODE_HOST = '10.0.0.5';
      process.env.AGENTAURA_ZCODE_PORT = '9090';
      process.env.AGENTAURA_ZCODE_TRANSPORT = 'udp';
      const config = loadConfig();
      assert.equal(config.host, '10.0.0.5');
      assert.equal(config.port, 9090);
      assert.equal(config.transport, 'udp');
    });
  });
});

test('serial_port accepts snake_case config key', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      const cfgPath = require('../out/config').configPath();
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      fs.writeFileSync(cfgPath, JSON.stringify({ serial_port: '/dev/ttyACM0', baud: 9600 }));
      const config = loadConfig();
      assert.equal(config.serialPort, '/dev/ttyACM0');
      assert.equal(config.baud, 9600);
    });
  });
});

test('mapZcodeEventToAgentState maps all 7 ZCode events', () => {
  assert.equal(mapZcodeEventToAgentState('SessionStart'), 'init');
  assert.equal(mapZcodeEventToAgentState('UserPromptSubmit'), 'running');
  assert.equal(mapZcodeEventToAgentState('PreToolUse'), 'busy');
  assert.equal(mapZcodeEventToAgentState('PermissionRequest'), 'waiting');
  assert.equal(mapZcodeEventToAgentState('PostToolUse'), 'running');
  assert.equal(mapZcodeEventToAgentState('PostToolUseFailure'), 'error');
  assert.equal(mapZcodeEventToAgentState('Stop'), 'idle');
});

test('ZCODE_HOOK_EVENTS contains exactly the 7 supported events', () => {
  assert.deepEqual([...ZCODE_HOOK_EVENTS], [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
  ]);
});

test('mapZcodeEventToAgentState detects error payloads', () => {
  assert.equal(mapZcodeEventToAgentState('PostToolUse', { success: false }), 'error');
  assert.equal(mapZcodeEventToAgentState('PostToolUse', { error: 'boom' }), 'error');
});

test('mapZcodeEventToAgentState detects waiting payloads', () => {
  assert.equal(mapZcodeEventToAgentState('Unknown', { permissionPrompt: true }), 'waiting');
  assert.equal(mapZcodeEventToAgentState('Unknown', { approvalRequest: true }), 'waiting');
});

test('buildHookCommand produces a quoted node invocation with the event name', () => {
  const { command } = buildHookCommand('Stop', {
    platform: 'linux',
    node: '/usr/bin/node',
    entry: '/tmp/idx.js',
  });
  assert.match(command, /\/usr\/bin\/node/);
  assert.match(command, /hook/);
  assert.match(command, /Stop/);
});

test('buildHookCommand uses powershell on win32', () => {
  const { command, shell } = buildHookCommand('Stop', {
    platform: 'win32',
    node: 'C:\\node.exe',
    entry: 'C:\\idx.js',
  });
  assert.equal(shell, 'powershell');
  assert.match(command, /&/);
});

test('installZcodeHooks writes managed hooks into config.json and uninstall removes them', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome((dir) => {
      // 模拟 cli/config.json 路径
      const cliDir = path.join(dir, 'cli');
      fs.mkdirSync(cliDir, { recursive: true });
      fs.writeFileSync(path.join(cliDir, 'config.json'), JSON.stringify({ someExisting: true }));

      const filePath = installZcodeHooks();
      const written = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      assert.equal(written.hooks.enabled, true);
      for (const event of ZCODE_HOOK_EVENTS) {
        assert.ok(written.hooks.events[event], `missing event ${event}`);
        const names = written.hooks.events[event].flatMap((e) => e.hooks.map((h) => h.name));
        assert.ok(names.some((n) => n && n.startsWith('agent-aura-zcode:')), `event ${event} missing managed hook`);
      }

      uninstallZcodeHooks();
      const after = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (after.hooks && after.hooks.events) {
        for (const event of ZCODE_HOOK_EVENTS) {
          const names = (after.hooks.events[event] || []).flatMap((e) => e.hooks.map((h) => h.name));
          assert.ok(!names.some((n) => n && n.startsWith('agent-aura-zcode:')), `event ${event} still has managed hook`);
        }
      }
    });
  });
});

test('runtime state survives save and load', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      saveRuntimeState({ lastState: 'busy', lastSentAt: 12345 });
      const state = loadRuntimeState();
      assert.equal(state.lastState, 'busy');
      assert.equal(state.lastSentAt, 12345);
    });
  });
});

test('RingLightClient describes configured firmware target', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      saveConfig({ host: '192.168.1.100', port: 80, transport: 'http' });
      const client = new RingLightClient(loadConfig());
      const desc = client.describe();
      assert.equal(desc.transport, 'http');
      assert.equal(desc.host, '192.168.1.100');
      assert.equal(desc.configured, true);
    });
  });
});

test('RingLightClient is not configured when host is empty', () => {
  withIsolatedEnv(() => {
    withTempZcodeHome(() => {
      const client = new RingLightClient(loadConfig());
      assert.equal(client.isConfigured, false);
    });
  });
});

test('buildZcodeMessage builds bubble text for tool events', () => {
  const tool = { tool_name: 'Bash' };
  assert.deepEqual(buildZcodeMessage('PreToolUse', 'busy', tool), { text: '正在运行 Bash', kind: 'activity' });
  assert.deepEqual(buildZcodeMessage('PermissionRequest', 'waiting', tool), { text: 'Bash 等待授权', kind: 'warning', priority: 60 });
  assert.deepEqual(buildZcodeMessage('PostToolUse', 'running', tool), { text: 'Bash 已完成', kind: 'success' });
  assert.deepEqual(buildZcodeMessage('PostToolUse', 'running', { tool_name: 'Bash', success: false }), { text: 'Bash 执行出错', kind: 'error', priority: 80 });
  assert.deepEqual(buildZcodeMessage('PostToolUse', 'running', { tool_name: 'Bash', success: false, error: 'command failed' }), { text: 'command failed', kind: 'error', priority: 80 });
  assert.deepEqual(buildZcodeMessage('PostToolUseFailure', 'error', { tool_name: 'Bash', error: 'timeout' }), { text: 'timeout', kind: 'error', priority: 80 });
  assert.deepEqual(buildZcodeMessage('PostToolUseFailure', 'error', tool), { text: 'Bash 执行出错', kind: 'error', priority: 80 });
  assert.deepEqual(buildZcodeMessage('Stop', 'idle'), { text: '任务已完成', kind: 'success' });
  assert.deepEqual(buildZcodeMessage('PreToolUse', 'busy', {}), { text: '正在运行 工具', kind: 'activity' });
  assert.equal(buildZcodeMessage('Unknown', 'running'), undefined);
  assert.equal(buildZcodeMessage('SessionEnd', 'offline'), undefined);
  assert.deepEqual(buildZcodeMessage('  PreToolUse  ', 'busy', tool), { text: '正在运行 Bash', kind: 'activity' });
});
