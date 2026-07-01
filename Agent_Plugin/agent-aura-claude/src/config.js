'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isTransportName } = require('./types');

const DEFAULT_CONFIG = {
  enabled: true,
  transport: 'http',
  host: '',
  port: 80,
  serialPort: '',
  baud: 115200,
  debounceMs: 500,
  cooldownMs: 3000,
  timeoutMs: 650,
  autoDiscover: true,
  authToken: '',
};

const DEFAULT_HOOK_SUPPRESSION_MS = 8000;

function claudeDir() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

function configPath() {
  return process.env.AGENTAURA_CLAUDE_CONFIG || path.join(claudeDir(), 'agent-aura-claude.json');
}

function configExists() {
  return fs.existsSync(configPath());
}

function runtimeStatePath() {
  if (process.env.AGENTAURA_CLAUDE_STATE) {
    return process.env.AGENTAURA_CLAUDE_STATE;
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return path.join(process.env.CLAUDE_PLUGIN_DATA, 'state.json');
  }
  return path.join(claudeDir(), 'agent-aura-claude-state.json');
}

function disabledPath() {
  return path.join(claudeDir(), 'agent-aura-claude.disabled');
}

function loadConfig() {
  const fileConfig = readJsonFile(configPath()) || {};
  const config = normalizeConfig(fileConfig);
  applyPluginOptionOverrides(config);
  applyEnvironmentOverrides(config);
  return normalizeConfig(config);
}

function saveConfig(patch) {
  const fileConfig = readJsonFile(configPath()) || {};
  const next = normalizeConfig({ ...fileConfig, ...patch });
  writeJsonFile(configPath(), next);
  return next;
}

function initConfig(force = false) {
  if (!force && configExists()) {
    return loadConfig();
  }
  const next = normalizeConfig(DEFAULT_CONFIG);
  writeJsonFile(configPath(), next);
  return next;
}

function loadRuntimeState() {
  return readJsonFile(runtimeStatePath()) || {};
}

function saveRuntimeState(state) {
  writeJsonFile(runtimeStatePath(), state);
}

function clearRuntimeState() {
  try {
    fs.unlinkSync(runtimeStatePath());
  } catch {
    // Missing state is fine.
  }
}

function suppressHooks(durationMs = DEFAULT_HOOK_SUPPRESSION_MS, reason = 'manual command') {
  const runtime = loadRuntimeState();
  saveRuntimeState({
    ...runtime,
    hookSuppressedUntil: Date.now() + durationMs,
    hookSuppressionReason: reason,
  });
}

function clearHookSuppression() {
  const runtime = loadRuntimeState();
  if (!runtime.hookSuppressedUntil && !runtime.hookSuppressionReason) {
    return;
  }
  const { hookSuppressedUntil, hookSuppressionReason, ...next } = runtime;
  saveRuntimeState(next);
}

function hooksSuppressed(now = Date.now()) {
  const until = Number(loadRuntimeState().hookSuppressedUntil || 0);
  return Number.isFinite(until) && until > now;
}

function isDisabled() {
  return fs.existsSync(disabledPath());
}

function setDisabled(disabled) {
  if (disabled) {
    fs.mkdirSync(path.dirname(disabledPath()), { recursive: true });
    fs.writeFileSync(disabledPath(), 'disabled\n', 'utf8');
    return;
  }
  try {
    fs.unlinkSync(disabledPath());
  } catch {
    // Missing disabled marker is fine.
  }
}

function normalizeConfig(input) {
  const transport = normalizeTransport(input.transport);
  const defaultPort = transport === 'udp' ? 8888 : 80;
  return {
    enabled: input.enabled !== false,
    transport,
    host: asString(input.host),
    port: normalizeInt(input.port, defaultPort, 1, 65535),
    serialPort: asString(input.serialPort ?? input.serial_port),
    baud: normalizeInt(input.baud, DEFAULT_CONFIG.baud, 1200, 4000000),
    debounceMs: normalizeInt(input.debounceMs ?? input.debounce_ms, DEFAULT_CONFIG.debounceMs, 0, 60000),
    cooldownMs: normalizeInt(input.cooldownMs ?? input.cooldown_ms, DEFAULT_CONFIG.cooldownMs, 0, 60000),
    timeoutMs: normalizeInt(input.timeoutMs ?? input.timeout_ms, DEFAULT_CONFIG.timeoutMs, 100, 10000),
    autoDiscover: input.autoDiscover !== false && input.auto_discover !== false,
    authToken: asString(input.authToken),
  };
}

function applyPluginOptionOverrides(config) {
  const enabled = readEnv('CLAUDE_PLUGIN_OPTION_ENABLED', 'CLAUDE_PLUGIN_OPTION_enabled');
  if (enabled !== undefined && parseBoolean(enabled) !== DEFAULT_CONFIG.enabled) {
    config.enabled = parseBoolean(enabled);
  }

  const transport = readEnv('CLAUDE_PLUGIN_OPTION_TRANSPORT', 'CLAUDE_PLUGIN_OPTION_transport');
  if (transport !== undefined && transport.trim() && transport.trim().toLowerCase() !== DEFAULT_CONFIG.transport) {
    const value = transport.trim().toLowerCase();
    if (isTransportName(value)) {
      config.transport = value;
    }
  }

  const host = readEnv('CLAUDE_PLUGIN_OPTION_HOST', 'CLAUDE_PLUGIN_OPTION_host');
  if (host !== undefined && host.trim()) {
    config.host = host.trim();
  }

  const port = readEnv('CLAUDE_PLUGIN_OPTION_PORT', 'CLAUDE_PLUGIN_OPTION_port');
  if (port !== undefined && Number(port) !== DEFAULT_CONFIG.port) {
    config.port = Number(port);
  }

  const serialPort = readEnv(
    'CLAUDE_PLUGIN_OPTION_SERIAL_PORT',
    'CLAUDE_PLUGIN_OPTION_serial_port',
    'CLAUDE_PLUGIN_OPTION_SERIALPORT',
  );
  if (serialPort !== undefined && serialPort.trim()) {
    config.serialPort = serialPort.trim();
  }

  const baud = readEnv('CLAUDE_PLUGIN_OPTION_BAUD', 'CLAUDE_PLUGIN_OPTION_baud');
  if (baud !== undefined && Number(baud) !== DEFAULT_CONFIG.baud) {
    config.baud = Number(baud);
  }

  const debounceMs = readEnv('CLAUDE_PLUGIN_OPTION_DEBOUNCE_MS', 'CLAUDE_PLUGIN_OPTION_debounce_ms');
  if (debounceMs !== undefined && Number(debounceMs) !== DEFAULT_CONFIG.debounceMs) {
    config.debounceMs = Number(debounceMs);
  }

  const cooldownMs = readEnv('CLAUDE_PLUGIN_OPTION_COOLDOWN_MS', 'CLAUDE_PLUGIN_OPTION_cooldown_ms');
  if (cooldownMs !== undefined && Number(cooldownMs) !== DEFAULT_CONFIG.cooldownMs) {
    config.cooldownMs = Number(cooldownMs);
  }

  const timeoutMs = readEnv('CLAUDE_PLUGIN_OPTION_TIMEOUT_MS', 'CLAUDE_PLUGIN_OPTION_timeout_ms');
  if (timeoutMs !== undefined && Number(timeoutMs) !== DEFAULT_CONFIG.timeoutMs) {
    config.timeoutMs = Number(timeoutMs);
  }

  const autoDiscover = readEnv('CLAUDE_PLUGIN_OPTION_AUTO_DISCOVER', 'CLAUDE_PLUGIN_OPTION_auto_discover');
  if (autoDiscover !== undefined && parseBoolean(autoDiscover) !== DEFAULT_CONFIG.autoDiscover) {
    config.autoDiscover = parseBoolean(autoDiscover);
  }

  const authToken = readEnv('CLAUDE_PLUGIN_OPTION_AUTH_TOKEN', 'CLAUDE_PLUGIN_OPTION_auth_token');
  if (authToken !== undefined && authToken.trim()) {
    config.authToken = authToken.trim();
  }
}

function applyEnvironmentOverrides(config) {
  const enabled = readEnv('AGENTAURA_CLAUDE_ENABLED', 'AGENTAURA_ENABLED');
  if (enabled !== undefined) {
    config.enabled = parseBoolean(enabled);
  }

  const transport = readEnv('AGENTAURA_CLAUDE_TRANSPORT', 'AGENTAURA_TRANSPORT');
  if (transport !== undefined && isTransportName(transport.trim().toLowerCase())) {
    config.transport = transport.trim().toLowerCase();
  }

  const host = readEnv('AGENTAURA_CLAUDE_HOST', 'AGENTAURA_HOST');
  if (host !== undefined) {
    config.host = host.trim();
  }

  const port = readEnv('AGENTAURA_CLAUDE_PORT', 'AGENTAURA_PORT');
  if (port !== undefined) {
    config.port = Number(port);
  }

  const serialPort = readEnv('AGENTAURA_CLAUDE_SERIAL_PORT', 'AGENTAURA_SERIAL_PORT');
  if (serialPort !== undefined) {
    config.serialPort = serialPort.trim();
  }

  const baud = readEnv('AGENTAURA_CLAUDE_BAUD', 'AGENTAURA_BAUD');
  if (baud !== undefined) {
    config.baud = Number(baud);
  }

  const debounceMs = readEnv('AGENTAURA_CLAUDE_DEBOUNCE_MS', 'AGENTAURA_DEBOUNCE_MS');
  if (debounceMs !== undefined) {
    config.debounceMs = Number(debounceMs);
  }

  const cooldownMs = readEnv('AGENTAURA_CLAUDE_COOLDOWN_MS', 'AGENTAURA_COOLDOWN_MS');
  if (cooldownMs !== undefined) {
    config.cooldownMs = Number(cooldownMs);
  }

  const timeoutMs = readEnv('AGENTAURA_CLAUDE_TIMEOUT_MS', 'AGENTAURA_TIMEOUT_MS');
  if (timeoutMs !== undefined) {
    config.timeoutMs = Number(timeoutMs);
  }

  const autoDiscover = readEnv('AGENTAURA_CLAUDE_AUTO_DISCOVER', 'AGENTAURA_AUTO_DISCOVER');
  if (autoDiscover !== undefined) {
    config.autoDiscover = parseBoolean(autoDiscover);
  }

  const authToken = readEnv('AGENTAURA_CLAUDE_AUTH_TOKEN', 'AGENTAURA_AUTH_TOKEN');
  if (authToken !== undefined) {
    config.authToken = authToken.trim();
  }
}

function normalizeTransport(value) {
  if (typeof value === 'string' && isTransportName(value.trim().toLowerCase())) {
    return value.trim().toLowerCase();
  }
  return DEFAULT_CONFIG.transport;
}

function readEnv(...names) {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

function parseBoolean(value) {
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function asString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInt(value, fallback, min, max) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) {
    return fallback;
  }
  const rounded = Math.round(n);
  if (rounded < min || rounded > max) {
    return fallback;
  }
  return rounded;
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    if (error instanceof SyntaxError && debugEnabled()) {
      process.stderr.write(`[agent-aura-claude] warning: failed to parse ${filePath}: ${error.message}\n`);
    }
    return null;
  }
}

function debugEnabled() {
  const value = process.env.AGENTAURA_CLAUDE_DEBUG || process.env.AGENTAURA_DEBUG || '';
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

module.exports = {
  DEFAULT_CONFIG,
  DEFAULT_HOOK_SUPPRESSION_MS,
  claudeDir,
  configPath,
  configExists,
  runtimeStatePath,
  disabledPath,
  loadConfig,
  saveConfig,
  initConfig,
  loadRuntimeState,
  saveRuntimeState,
  clearRuntimeState,
  suppressHooks,
  clearHookSuppression,
  hooksSuppressed,
  isDisabled,
  setDisabled,
};
