'use strict';

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isTransportName, type Transport } from './types';

export interface Config {
  enabled: boolean;
  transport: Transport;
  host: string;
  port: number;
  serialPort: string;
  baud: number;
  debounceMs: number;
  cooldownMs: number;
  timeoutMs: number;
  autoDiscover: boolean;
  authToken: string;
}

export interface RuntimeState {
  hookSuppressedUntil?: number;
  hookSuppressionReason?: string;
  [key: string]: unknown;
}

export const DEFAULT_CONFIG: Config = {
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

export const DEFAULT_HOOK_SUPPRESSION_MS = 8000;

export function claudeDir(): string {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), '.claude');
}

export function configPath(): string {
  return process.env.AGENTAURA_CLAUDE_CONFIG || path.join(claudeDir(), 'agent-aura-claude.json');
}

export function configExists(): boolean {
  return fs.existsSync(configPath());
}

export function runtimeStatePath(): string {
  if (process.env.AGENTAURA_CLAUDE_STATE) {
    return process.env.AGENTAURA_CLAUDE_STATE;
  }
  if (process.env.CLAUDE_PLUGIN_DATA) {
    return path.join(process.env.CLAUDE_PLUGIN_DATA, 'state.json');
  }
  return path.join(claudeDir(), 'agent-aura-claude-state.json');
}

export function disabledPath(): string {
  return path.join(claudeDir(), 'agent-aura-claude.disabled');
}

export function loadConfig(): Config {
  const fileConfig = readJsonFile(configPath()) || {};
  const config = normalizeConfig(fileConfig);
  applyPluginOptionOverrides(config);
  applyEnvironmentOverrides(config);
  return normalizeConfig(config as unknown as Record<string, unknown>);
}

export function saveConfig(patch: Partial<Config>): Config {
  const fileConfig = readJsonFile(configPath()) || {};
  const next = normalizeConfig({ ...fileConfig, ...patch } as Record<string, unknown>);
  writeJsonFile(configPath(), next);
  return next;
}

export function initConfig(force = false): Config {
  if (!force && configExists()) {
    return loadConfig();
  }
  const next = normalizeConfig({ ...DEFAULT_CONFIG });
  writeJsonFile(configPath(), next);
  return next;
}

export function loadRuntimeState(): RuntimeState {
  return readJsonFile(runtimeStatePath()) || {};
}

export function saveRuntimeState(state: RuntimeState): void {
  writeJsonFile(runtimeStatePath(), state);
}

export function clearRuntimeState(): void {
  try {
    fs.unlinkSync(runtimeStatePath());
  } catch {
    // Missing state is fine.
  }
}

export function suppressHooks(durationMs = DEFAULT_HOOK_SUPPRESSION_MS, reason = 'manual command'): void {
  const runtime = loadRuntimeState();
  saveRuntimeState({
    ...runtime,
    hookSuppressedUntil: Date.now() + durationMs,
    hookSuppressionReason: reason,
  });
}

export function clearHookSuppression(): void {
  const runtime = loadRuntimeState();
  if (!runtime.hookSuppressedUntil && !runtime.hookSuppressionReason) {
    return;
  }
  const { hookSuppressedUntil, hookSuppressionReason, ...next } = runtime;
  saveRuntimeState(next as RuntimeState);
}

export function hooksSuppressed(now = Date.now()): boolean {
  const until = Number(loadRuntimeState().hookSuppressedUntil || 0);
  return Number.isFinite(until) && until > now;
}

export function isDisabled(): boolean {
  return fs.existsSync(disabledPath());
}

export function setDisabled(disabled: boolean): void {
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

function normalizeConfig(input: Record<string, unknown>): Config {
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

function applyPluginOptionOverrides(config: Config): void {
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

function applyEnvironmentOverrides(config: Config): void {
  const enabled = readEnv('AGENTAURA_CLAUDE_ENABLED', 'AGENTAURA_ENABLED');
  if (enabled !== undefined) {
    config.enabled = parseBoolean(enabled);
  }

  const transport = readEnv('AGENTAURA_CLAUDE_TRANSPORT', 'AGENTAURA_TRANSPORT');
  if (transport !== undefined && isTransportName(transport.trim().toLowerCase())) {
    config.transport = transport.trim().toLowerCase() as Transport;
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

function normalizeTransport(value: unknown): Transport {
  if (typeof value === 'string' && isTransportName(value.trim().toLowerCase())) {
    return value.trim().toLowerCase() as Transport;
  }
  return DEFAULT_CONFIG.transport;
}

function readEnv(...names: string[]): string | undefined {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== '') {
      return value;
    }
  }
  return undefined;
}

export function parseBoolean(value: unknown): boolean {
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
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

export function readJsonFile(filePath: string): Record<string, unknown> | null {
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

export function debugEnabled(): boolean {
  const value = process.env.AGENTAURA_CLAUDE_DEBUG || process.env.AGENTAURA_DEBUG || '';
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function writeJsonFile(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
