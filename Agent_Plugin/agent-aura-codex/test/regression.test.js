const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadConfig, saveConfig } = require('../out/config');
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

    const saved = saveConfig({ transport: 'http', host: 'file-host' });
    assert.equal(saved.host, 'file-host');
    assert.equal(saved.port, 80);
    assert.equal(saved.autoDiscover, true);

    const persisted = JSON.parse(fs.readFileSync(path.join(codexHome, 'agent-aura-codex.json'), 'utf8'));
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
    assert.ok(document.hooks.UserPromptSubmit);
  }));
});

test('installCodexHooks writes hook commands with the current Node executable', () => {
  withIsolatedEnv(() => withTempCodexHome((codexHome) => {
    const hooksPath = path.join(codexHome, 'hooks.json');
    fs.writeFileSync(hooksPath, JSON.stringify({
      hooks: {
        UserPromptSubmit: [
          { hooks: [{ type: 'command', command: 'echo keep-me' }] },
        ],
      },
    }, null, 2), 'utf8');

    installCodexHooks();

    const document = JSON.parse(fs.readFileSync(hooksPath, 'utf8'));
    const groups = document.hooks.UserPromptSubmit;
    assert.equal(groups[0].hooks[0].command, 'echo keep-me');

    const installedHook = groups.flatMap((group) => group.hooks)
      .find((hook) => hook.command.includes('AGENTAURA_CODEX_HOOK=1'));
    assert.ok(installedHook, 'expected AgentAura hook to be installed');
    assert.ok(installedHook.command.includes(process.execPath), installedHook.command);
  }));
});
