'use strict';

const path = require('node:path');
const {
  clearRuntimeState,
  configPath,
  disabledPath,
  initConfig,
  isDisabled,
  loadConfig,
  loadRuntimeState,
  runtimeStatePath,
  saveConfig,
  setDisabled,
} = require('./config');
const { discoverDevices } = require('./discovery');
const { RingLightClient } = require('./deviceClient');
const { CLAUDE_EVENT_TO_AGENT_STATE, CLAUDE_HOOK_EVENTS, runClaudeHook } = require('./hooks');
const { isAgentState, isTransportName } = require('./types');

async function main(argv = process.argv.slice(2)) {
  const [command = 'help', ...args] = argv;

  if (command === 'hook') {
    await runClaudeHook(args[0]);
    return;
  }

  switch (command) {
    case 'configure':
      await configure(args);
      break;
    case 'config':
      await configCommand(args);
      break;
    case 'show-config':
      printJson({ path: configPath(), config: loadConfig() });
      break;
    case 'discover':
      await discover(args);
      break;
    case 'test':
    case 'state':
      await testState(args);
      break;
    case 'command':
    case 'cmd':
      await sendCommand(args);
      break;
    case 'status':
    case 'doctor':
      await status(args);
      break;
    case 'hooks':
      hooksCommand();
      break;
    case 'disable':
    case 'off':
      setDisabled(true);
      console.log(`AgentAura Claude disabled: ${disabledPath()}`);
      break;
    case 'enable':
    case 'on':
      setDisabled(false);
      console.log('AgentAura Claude enabled');
      break;
    case 'reset-cache':
      clearRuntimeState();
      console.log('Cleared AgentAura Claude runtime state.');
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exitCode = 2;
  }
}

async function configCommand(args) {
  const [subcommand = 'get', ...rest] = args;
  if (subcommand === 'get') {
    printJson({ path: configPath(), config: loadConfig() });
    return;
  }
  if (subcommand === 'path') {
    console.log(configPath());
    return;
  }
  if (subcommand === 'init') {
    const { flags } = parseArgs(rest);
    const config = initConfig(flags.force !== undefined);
    printJson({ path: configPath(), config });
    return;
  }
  if (subcommand === 'set') {
    await configure(rest);
    return;
  }
  throw new Error('Usage: agent-aura-claude config get|path|init|set ...');
}

async function configure(args) {
  const { flags } = parseArgs(args);
  const patch = {};

  if (flags.enabled !== undefined) {
    patch.enabled = parseBoolean(flags.enabled);
  }
  if (flags.transport !== undefined) {
    const value = flags.transport.toLowerCase();
    if (!isTransportName(value)) {
      throw new Error('--transport must be http, udp, or serial');
    }
    patch.transport = value;
    if (value === 'http' && flags.port === undefined) {
      patch.port = 80;
    }
    if (value === 'udp' && flags.port === undefined) {
      patch.port = 8888;
    }
  }
  if (flags.host !== undefined) {
    patch.host = flags.host;
  }
  if (flags.port !== undefined) {
    patch.port = parseNumberFlag(flags.port, '--port');
  }
  if (flags.serialPort !== undefined) {
    patch.serialPort = flags.serialPort;
  }
  if (flags.baud !== undefined) {
    patch.baud = parseNumberFlag(flags.baud, '--baud');
  }
  if (flags.debounceMs !== undefined) {
    patch.debounceMs = parseNumberFlag(flags.debounceMs, '--debounce-ms');
  }
  if (flags.cooldownMs !== undefined) {
    patch.cooldownMs = parseNumberFlag(flags.cooldownMs, '--cooldown-ms');
  }
  if (flags.timeoutMs !== undefined) {
    patch.timeoutMs = parseNumberFlag(flags.timeoutMs, '--timeout-ms');
  }
  if (flags.autoDiscover !== undefined) {
    patch.autoDiscover = parseBoolean(flags.autoDiscover);
  }

  if (flags.discover !== undefined) {
    const devices = await discoverDevices(2500);
    const first = devices[0];
    if (!first?.ip) {
      throw new Error('No AgentAura ring light found via UDP discovery');
    }
    patch.transport = 'http';
    patch.host = first.ip;
    patch.port = first.http || 80;
  }

  const config = saveConfig(patch);
  printJson({ path: configPath(), config });
}

async function discover(args) {
  const { flags } = parseArgs(args);
  const timeout = flags.timeout ? parseNumberFlag(flags.timeout, '--timeout') : 2500;
  const devices = await discoverDevices(timeout);

  if (flags.save !== undefined || flags.saveFirst !== undefined) {
    const first = devices[0];
    if (!first?.ip) {
      throw new Error('No device found to save');
    }
    const config = saveConfig({ transport: 'http', host: first.ip, port: first.http || 80 });
    printJson({ devices, saved: config });
    return;
  }

  printJson({ devices });
}

async function testState(args) {
  const state = (args[0] || '').trim().toLowerCase();
  if (!isAgentState(state)) {
    throw new Error('state must be one of: running, busy, waiting, error, idle, init, offline, upgrade');
  }
  const ok = await new RingLightClient(loadConfig()).sendAgentState(state);
  if (!ok) {
    throw new Error(`Failed to send agent state ${state}. Check config and device reachability.`);
  }
  console.log(`Sent agent ${state}`);
}

async function sendCommand(args) {
  const raw = args.join(' ').trim();
  if (!raw) {
    throw new Error('command text is required');
  }
  const ok = await new RingLightClient(loadConfig()).sendCommand(raw);
  if (!ok) {
    throw new Error(`Failed to send command: ${raw}`);
  }
  console.log(`Sent: ${raw}`);
}

async function status(args) {
  const { flags } = parseArgs(args);
  const config = loadConfig();
  const client = new RingLightClient(config);
  const result = {
    disabled: isDisabled(),
    disabledPath: disabledPath(),
    configPath: configPath(),
    runtimeStatePath: runtimeStatePath(),
    pluginDataPath: process.env.CLAUDE_PLUGIN_DATA || null,
    bundledHooksPath: path.resolve(__dirname, '..', 'hooks', 'hooks.json'),
    config,
    client: client.describe(),
    runtime: loadRuntimeState(),
    hookMapping: CLAUDE_EVENT_TO_AGENT_STATE,
  };
  if (flags.probe !== undefined) {
    result.device = await client.health();
  }
  printJson(result);
}

function hooksCommand() {
  printJson({
    path: path.resolve(__dirname, '..', 'hooks', 'hooks.json'),
    events: CLAUDE_HOOK_EVENTS,
    mapping: CLAUDE_EVENT_TO_AGENT_STATE,
  });
}

function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const body = arg.slice(2);
    const eq = body.indexOf('=');
    if (eq >= 0) {
      flags[toCamel(body.slice(0, eq))] = body.slice(eq + 1);
      continue;
    }
    const key = toCamel(body);
    const next = args[index + 1];
    if (next !== undefined && !next.startsWith('--')) {
      flags[key] = next;
      index += 1;
    } else {
      flags[key] = 'true';
    }
  }
  return { flags, positional };
}

function toCamel(key) {
  return key.replace(/-([a-z])/g, (_, character) => character.toUpperCase());
}

function parseBoolean(value) {
  if (value === undefined) {
    return true;
  }
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function parseNumberFlag(value, label) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} must be a number`);
  }
  return Math.round(parsed);
}

function printJson(value) {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp() {
  console.log(`AgentAura Claude Ring Light

Usage:
  agent-aura-claude configure --transport http --host 192.168.1.100 --port 80
  agent-aura-claude configure --discover
  agent-aura-claude test busy
  agent-aura-claude command "rgb 255,0,0"
  agent-aura-claude discover --save
  agent-aura-claude status --probe

Claude Code plugin:
  claude --plugin-dir .
  /reload-plugins

Commands:
  config get|path|init|set
  configure --transport http|udp|serial --host <ip> --port <port>
  discover [--save] [--timeout 2500]
  test running|busy|waiting|error|idle|init|offline|upgrade
  command <firmware text command>
  status [--probe]
  hooks
  disable|enable
  reset-cache

Claude hook events:
  ${CLAUDE_HOOK_EVENTS.join(', ')}

Environment overrides:
  AGENTAURA_CLAUDE_TRANSPORT=http|udp|serial
  AGENTAURA_CLAUDE_HOST=192.168.1.100
  AGENTAURA_CLAUDE_PORT=80
  AGENTAURA_CLAUDE_SERIAL_PORT=/dev/ttyACM0
  AGENTAURA_CLAUDE_BAUD=115200
  AGENTAURA_CLAUDE_ENABLED=true|false
`);
}

function runCli() {
  main().catch((error) => {
    console.error(error.message || String(error));
    process.exitCode = 1;
  });
}

if (require.main === module) {
  runCli();
}

module.exports = {
  main,
  runCli,
  parseArgs,
  parseBoolean,
};
