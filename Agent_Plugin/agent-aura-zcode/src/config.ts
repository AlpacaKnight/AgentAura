import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { AgentAuraConfig, RuntimeState, TransportName, isTransportName } from './types';

export const DEFAULT_CONFIG: AgentAuraConfig = {
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

/**
 * ZCode 用户配置目录解析。
 * 优先级：ZCODE_HOME > ZCODE_CODE_HOME > ~/.zcode
 */
export function zcodeDir(): string {
    return process.env.ZCODE_HOME || process.env.ZCODE_CODE_HOME || path.join(os.homedir(), '.zcode');
}

export function configPath(): string {
    return process.env.AGENTAURA_ZCODE_CONFIG || path.join(zcodeDir(), 'agent-aura-zcode.json');
}

export function configExists(): boolean {
    return fs.existsSync(configPath());
}

/**
 * 运行时状态路径。优先使用插件数据目录（ZCode 注入 ZCODE_PLUGIN_DATA），
 * 回退到 ZCode 目录下的独立文件。
 */
export function runtimeStatePath(): string {
    if (process.env.AGENTAURA_ZCODE_STATE) {
        return process.env.AGENTAURA_ZCODE_STATE;
    }
    if (process.env.ZCODE_PLUGIN_DATA) {
        return path.join(process.env.ZCODE_PLUGIN_DATA, 'state.json');
    }
    return path.join(zcodeDir(), 'agent-aura-zcode-state.json');
}

export function disabledPath(): string {
    return path.join(zcodeDir(), 'agent-aura-zcode.disabled');
}

/**
 * ZCode 配置文件 hooks 路径（~/.zcode/cli/config.json）。
 * 插件自带 hooks/hooks.json 会自动启用 hook runner，这里仅作为
 * 辅助路径供 PetDesktop 托管安装和 CLI 排障使用。
 */
export function zcodeConfigPath(): string {
    return process.env.ZCODE_CONFIG || path.join(zcodeDir(), 'cli', 'config.json');
}

export function loadConfig(): AgentAuraConfig {
    const fileConfig = readJsonFile<Partial<AgentAuraConfig>>(configPath()) || {};
    const config = normalizeConfig(fileConfig);
    applyPluginOptionOverrides(config);
    applyEnvironmentOverrides(config);
    return normalizeConfig(config as unknown as Partial<AgentAuraConfig>);
}

export function saveConfig(patch: Partial<AgentAuraConfig>): AgentAuraConfig {
    const fileConfig = readJsonFile<Partial<AgentAuraConfig>>(configPath()) || {};
    const next = normalizeConfig({ ...fileConfig, ...patch } as Record<string, unknown>);
    writeJsonFile(configPath(), next);
    return next;
}

export function initConfig(force = false): AgentAuraConfig {
    if (!force && configExists()) {
        return loadConfig();
    }
    const next = normalizeConfig({ ...DEFAULT_CONFIG });
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

export function readHooksText(): string {
    const filePath = zcodeConfigPath();
    try {
        if (!fs.existsSync(filePath)) {
            return '';
        }
        return fs.readFileSync(filePath, 'utf8');
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot read ZCode config file ${filePath}: ${message}`);
    }
}

export function writeHooksText(text: string): void {
    fs.mkdirSync(path.dirname(zcodeConfigPath()), { recursive: true });
    fs.writeFileSync(zcodeConfigPath(), text, 'utf8');
}

function normalizeConfig(input: Partial<AgentAuraConfig>): AgentAuraConfig {
    const transport = normalizeTransport(input.transport);
    const defaultPort = transport === 'udp' ? 8888 : 80;
    return {
        enabled: input.enabled !== false,
        transport,
        host: asString(input.host),
        port: normalizeInt(input.port, defaultPort, 1, 65535),
        serialPort: asString(input.serialPort ?? (input as Record<string, unknown>).serial_port),
        baud: normalizeInt(input.baud, DEFAULT_CONFIG.baud, 1200, 4000000),
        debounceMs: normalizeInt(input.debounceMs ?? (input as Record<string, unknown>).debounce_ms, DEFAULT_CONFIG.debounceMs, 0, 60000),
        cooldownMs: normalizeInt(input.cooldownMs ?? (input as Record<string, unknown>).cooldown_ms, DEFAULT_CONFIG.cooldownMs, 0, 60000),
        timeoutMs: normalizeInt(input.timeoutMs ?? (input as Record<string, unknown>).timeout_ms, DEFAULT_CONFIG.timeoutMs, 100, 10000),
        autoDiscover: input.autoDiscover !== false && (input as Record<string, unknown>).auto_discover !== false,
        authToken: asString(input.authToken),
    };
}

/**
 * 读取 ZCode 插件 userConfig 注入的环境变量。
 * ZCode 将 userConfig 的值以 ZCODE_PLUGIN_OPTION_<key> 形式注入子进程环境。
 */
function applyPluginOptionOverrides(config: AgentAuraConfig): void {
    const enabled = readEnv('ZCODE_PLUGIN_OPTION_ENABLED', 'ZCODE_PLUGIN_OPTION_enabled');
    if (enabled !== undefined && parseBoolean(enabled) !== DEFAULT_CONFIG.enabled) {
        config.enabled = parseBoolean(enabled);
    }

    const transport = readEnv('ZCODE_PLUGIN_OPTION_TRANSPORT', 'ZCODE_PLUGIN_OPTION_transport');
    if (transport !== undefined && transport.trim() && transport.trim().toLowerCase() !== DEFAULT_CONFIG.transport) {
        const value = transport.trim().toLowerCase();
        if (isTransportName(value)) {
            config.transport = value as TransportName;
        }
    }

    const host = readEnv('ZCODE_PLUGIN_OPTION_HOST', 'ZCODE_PLUGIN_OPTION_host');
    if (host !== undefined && host.trim()) {
        config.host = host.trim();
    }

    const port = readEnv('ZCODE_PLUGIN_OPTION_PORT', 'ZCODE_PLUGIN_OPTION_port');
    if (port !== undefined && Number(port) !== DEFAULT_CONFIG.port) {
        config.port = Number(port);
    }

    const serialPort = readEnv(
        'ZCODE_PLUGIN_OPTION_SERIAL_PORT',
        'ZCODE_PLUGIN_OPTION_serial_port',
        'ZCODE_PLUGIN_OPTION_SERIALPORT',
    );
    if (serialPort !== undefined && serialPort.trim()) {
        config.serialPort = serialPort.trim();
    }

    const baud = readEnv('ZCODE_PLUGIN_OPTION_BAUD', 'ZCODE_PLUGIN_OPTION_baud');
    if (baud !== undefined && Number(baud) !== DEFAULT_CONFIG.baud) {
        config.baud = Number(baud);
    }

    const debounceMs = readEnv('ZCODE_PLUGIN_OPTION_DEBOUNCE_MS', 'ZCODE_PLUGIN_OPTION_debounce_ms');
    if (debounceMs !== undefined && Number(debounceMs) !== DEFAULT_CONFIG.debounceMs) {
        config.debounceMs = Number(debounceMs);
    }

    const cooldownMs = readEnv('ZCODE_PLUGIN_OPTION_COOLDOWN_MS', 'ZCODE_PLUGIN_OPTION_cooldown_ms');
    if (cooldownMs !== undefined && Number(cooldownMs) !== DEFAULT_CONFIG.cooldownMs) {
        config.cooldownMs = Number(cooldownMs);
    }

    const timeoutMs = readEnv('ZCODE_PLUGIN_OPTION_TIMEOUT_MS', 'ZCODE_PLUGIN_OPTION_timeout_ms');
    if (timeoutMs !== undefined && Number(timeoutMs) !== DEFAULT_CONFIG.timeoutMs) {
        config.timeoutMs = Number(timeoutMs);
    }

    const autoDiscover = readEnv('ZCODE_PLUGIN_OPTION_AUTO_DISCOVER', 'ZCODE_PLUGIN_OPTION_auto_discover');
    if (autoDiscover !== undefined && parseBoolean(autoDiscover) !== DEFAULT_CONFIG.autoDiscover) {
        config.autoDiscover = parseBoolean(autoDiscover);
    }

    const authToken = readEnv('ZCODE_PLUGIN_OPTION_AUTH_TOKEN', 'ZCODE_PLUGIN_OPTION_auth_token');
    if (authToken !== undefined && authToken.trim()) {
        config.authToken = authToken.trim();
    }
}

function applyEnvironmentOverrides(config: AgentAuraConfig): void {
    const enabled = readEnv('AGENTAURA_ZCODE_ENABLED', 'AGENTAURA_ENABLED');
    if (enabled !== undefined) {
        config.enabled = parseBoolean(enabled);
    }

    const transport = readEnv('AGENTAURA_ZCODE_TRANSPORT', 'AGENTAURA_TRANSPORT');
    if (transport !== undefined && isTransportName(transport.trim().toLowerCase())) {
        config.transport = transport.trim().toLowerCase() as TransportName;
    }

    const host = readEnv('AGENTAURA_ZCODE_HOST', 'AGENTAURA_HOST');
    if (host !== undefined) {
        config.host = host.trim();
    }

    const port = readEnv('AGENTAURA_ZCODE_PORT', 'AGENTAURA_PORT');
    if (port !== undefined) {
        config.port = Number(port);
    }

    const serialPort = readEnv('AGENTAURA_ZCODE_SERIAL_PORT', 'AGENTAURA_SERIAL_PORT');
    if (serialPort !== undefined) {
        config.serialPort = serialPort.trim();
    }

    const baud = readEnv('AGENTAURA_ZCODE_BAUD', 'AGENTAURA_BAUD');
    if (baud !== undefined) {
        config.baud = Number(baud);
    }

    const debounceMs = readEnv('AGENTAURA_ZCODE_DEBOUNCE_MS', 'AGENTAURA_DEBOUNCE_MS');
    if (debounceMs !== undefined) {
        config.debounceMs = Number(debounceMs);
    }

    const cooldownMs = readEnv('AGENTAURA_ZCODE_COOLDOWN_MS', 'AGENTAURA_COOLDOWN_MS');
    if (cooldownMs !== undefined) {
        config.cooldownMs = Number(cooldownMs);
    }

    const timeoutMs = readEnv('AGENTAURA_ZCODE_TIMEOUT_MS', 'AGENTAURA_TIMEOUT_MS');
    if (timeoutMs !== undefined) {
        config.timeoutMs = Number(timeoutMs);
    }

    const autoDiscover = readEnv('AGENTAURA_ZCODE_AUTO_DISCOVER', 'AGENTAURA_AUTO_DISCOVER');
    if (autoDiscover !== undefined) {
        config.autoDiscover = parseBoolean(autoDiscover);
    }

    const authToken = readEnv('AGENTAURA_ZCODE_AUTH_TOKEN', 'AGENTAURA_AUTH_TOKEN');
    if (authToken !== undefined) {
        config.authToken = authToken.trim();
    }
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

function readJsonFile<T>(filePath: string): T | null {
    try {
        if (!fs.existsSync(filePath)) {
            return null;
        }
        return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
    } catch (error) {
        if (error instanceof SyntaxError && debugEnabled()) {
            process.stderr.write(`[agent-aura-zcode] warning: failed to parse ${filePath}: ${error.message}\n`);
        }
        return null;
    }
}

export function debugEnabled(): boolean {
    const value = process.env.AGENTAURA_ZCODE_DEBUG || process.env.AGENTAURA_DEBUG || '';
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function writeJsonFile(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
