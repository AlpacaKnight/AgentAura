import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AgentAuraConfig, RuntimeState, TransportName, isTransportName } from './types';

export function codexDir(): string {
    return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

export function configPath(): string {
    return process.env.AGENTAURA_CODEX_CONFIG || path.join(codexDir(), 'agent-aura-codex.json');
}

export function configExists(): boolean {
    return fs.existsSync(configPath());
}

export function runtimeStatePath(): string {
    return path.join(codexDir(), 'agent-aura-codex-state.json');
}

export function disabledPath(): string {
    return path.join(codexDir(), 'agent-aura-codex.disabled');
}

export function codexHooksPath(): string {
    return process.env.CODEX_HOOKS_FILE || path.join(codexDir(), 'hooks.json');
}

const DEFAULT_CONFIG: AgentAuraConfig = {
    enabled: true,
    transport: 'http',
    host: '',
    port: 80,
    serialPort: '',
    baud: 115200,
    debounceMs: 500,
    cooldownMs: 3000,
    timeoutMs: 650,
    idleFallbackMs: 5000,
    autoDiscover: true,
    authToken: '',
};

export function loadConfig(): AgentAuraConfig {
    const fileConfig = readJsonFile<Partial<AgentAuraConfig>>(configPath()) || {};
    const config = normalizeConfig(fileConfig);
    applyEnvironmentOverrides(config);
    return normalizeConfig(config);
}

export function saveConfig(patch: Partial<AgentAuraConfig>): AgentAuraConfig {
    const fileConfig = readJsonFile<Partial<AgentAuraConfig>>(configPath()) || {};
    const next = normalizeConfig({ ...fileConfig, ...patch });
    writeJsonFile(configPath(), next);
    return next;
}

export function initConfig(force = false): AgentAuraConfig {
    if (!force && configExists()) {
        return loadConfig();
    }
    const next = normalizeConfig(DEFAULT_CONFIG);
    writeJsonFile(configPath(), next);
    return next;
}

export function loadRuntimeState(): RuntimeState {
    return readJsonFile<RuntimeState>(runtimeStatePath()) || {};
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

export function readHooksDocument(): unknown {
    const filePath = codexHooksPath();
    try {
        if (!fs.existsSync(filePath)) { return { hooks: {} }; }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read Codex hooks file ${filePath}: ${message}`);
    }
}

export function writeHooksDocument(document: unknown): void {
    writeJsonFile(codexHooksPath(), document);
}

function normalizeConfig(input: Partial<AgentAuraConfig>): AgentAuraConfig {
    const transport = normalizeTransport(input.transport);
    const defaultPort = transport === 'udp' ? 8888 : 80;
    return {
        enabled: input.enabled !== false,
        transport,
        host: asString(input.host),
        port: normalizeInt(input.port, defaultPort, 1, 65535),
        serialPort: asString(input.serialPort),
        baud: normalizeInt(input.baud, DEFAULT_CONFIG.baud, 1200, 4000000),
        debounceMs: normalizeInt(input.debounceMs, DEFAULT_CONFIG.debounceMs, 0, 60000),
        cooldownMs: normalizeInt(input.cooldownMs, DEFAULT_CONFIG.cooldownMs, 0, 60000),
        timeoutMs: normalizeInt(input.timeoutMs, DEFAULT_CONFIG.timeoutMs, 100, 10000),
        idleFallbackMs: normalizeInt(input.idleFallbackMs, DEFAULT_CONFIG.idleFallbackMs, 0, 600000),
        autoDiscover: input.autoDiscover !== false,
        authToken: asString(input.authToken),
    };
}

function applyEnvironmentOverrides(config: AgentAuraConfig): void {
    const enabled = readEnv('AGENTAURA_CODEX_ENABLED', 'AGENTAURA_ENABLED');
    if (enabled !== undefined) { config.enabled = parseBoolean(enabled); }

    const transport = readEnv('AGENTAURA_CODEX_TRANSPORT', 'AGENTAURA_TRANSPORT');
    if (transport !== undefined && isTransportName(transport.toLowerCase())) {
        config.transport = transport.toLowerCase() as TransportName;
    }

    const host = readEnv('AGENTAURA_CODEX_HOST', 'AGENTAURA_HOST');
    if (host !== undefined) { config.host = host.trim(); }

    const port = readEnv('AGENTAURA_CODEX_PORT', 'AGENTAURA_PORT');
    if (port !== undefined) { config.port = Number(port); }

    const serialPort = readEnv('AGENTAURA_CODEX_SERIAL_PORT', 'AGENTAURA_SERIAL_PORT');
    if (serialPort !== undefined) { config.serialPort = serialPort.trim(); }

    const baud = readEnv('AGENTAURA_CODEX_BAUD', 'AGENTAURA_BAUD');
    if (baud !== undefined) { config.baud = Number(baud); }

    const debounceMs = readEnv('AGENTAURA_CODEX_DEBOUNCE_MS', 'AGENTAURA_DEBOUNCE_MS');
    if (debounceMs !== undefined) { config.debounceMs = Number(debounceMs); }

    const cooldownMs = readEnv('AGENTAURA_CODEX_COOLDOWN_MS', 'AGENTAURA_COOLDOWN_MS');
    if (cooldownMs !== undefined) { config.cooldownMs = Number(cooldownMs); }

    const timeoutMs = readEnv('AGENTAURA_CODEX_TIMEOUT_MS', 'AGENTAURA_TIMEOUT_MS');
    if (timeoutMs !== undefined) { config.timeoutMs = Number(timeoutMs); }

    const idleFallbackMs = readEnv('AGENTAURA_CODEX_IDLE_FALLBACK_MS', 'AGENTAURA_IDLE_FALLBACK_MS');
    if (idleFallbackMs !== undefined) { config.idleFallbackMs = Number(idleFallbackMs); }

    const autoDiscover = readEnv('AGENTAURA_CODEX_AUTO_DISCOVER', 'AGENTAURA_AUTO_DISCOVER');
    if (autoDiscover !== undefined) { config.autoDiscover = parseBoolean(autoDiscover); }

    const authToken = readEnv('AGENTAURA_CODEX_AUTH_TOKEN', 'AGENTAURA_AUTH_TOKEN');
    if (authToken !== undefined) { config.authToken = authToken.trim(); }
}

function normalizeTransport(value: unknown): TransportName {
    if (typeof value === 'string' && isTransportName(value.trim().toLowerCase())) {
        return value.trim().toLowerCase() as TransportName;
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

function parseBoolean(value: string): boolean {
    return !['0', 'false', 'no', 'off'].includes(value.trim().toLowerCase());
}

function asString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function normalizeInt(value: unknown, fallback: number, min: number, max: number): number {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) { return fallback; }
    const rounded = Math.round(n);
    if (rounded < min || rounded > max) { return fallback; }
    return rounded;
}

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) { return null; }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch {
        return null;
    }
}

function writeJsonFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}
`, 'utf8');
}
