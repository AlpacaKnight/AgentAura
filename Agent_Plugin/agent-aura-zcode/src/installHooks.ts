import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readHooksText, writeHooksText, zcodeConfigPath } from './config';
import { ZCODE_EVENT_TO_AGENT_STATE, ZCODE_HOOK_EVENTS } from './hooks';

const HOOK_NAME_PREFIX = 'agent-aura-zcode:';
const HOOK_TIMEOUT_SEC = 5;
const HOOK_ENV: Record<string, string> = { AGENTAURA_ZCODE_HOOK: '1' };

type HookShell = 'bash' | 'powershell';

type HookCommand = {
    type: 'command';
    command: string;
    name: string;
    timeout: number;
    env?: Record<string, string>;
    shell?: HookShell;
};

type HookEntry = {
    matcher?: string;
    hooks: HookCommand[];
};

type ZcodeConfig = {
    hooks?: {
        enabled?: boolean;
        events?: Record<string, HookEntry[]>;
    } & Record<string, unknown>;
    [key: string]: unknown;
};

/**
 * 写入配置文件 hooks 到 ~/.zcode/cli/config.json 的 hooks.events 字段。
 *
 * 说明：插件自带的 hooks/hooks.json 会自动启用 hook runner，这是主要安装方式。
 * 本函数是辅助路径，用于 PetDesktop 托管安装和 CLI 排障：它把同一组 hook 写入
 * 配置文件，并设置 hooks.enabled = true。两套 hooks 共存时插件 hooks 追加在
 * 配置 hooks 之后，互不冲突（每个 hook 独立执行）。
 */
export function installZcodeHooks(): string {
    const config = readConfig();
    const hooks = config.hooks || {};
    const events = { ...(hooks.events || {}) };
    for (const eventName of ZCODE_HOOK_EVENTS) {
        events[eventName] = appendManagedHook(entriesWithoutManagedHooks(events[eventName]), eventName);
    }
    config.hooks = { ...hooks, enabled: true, events };
    writeConfig(config);
    return zcodeConfigPath();
}

export function uninstallZcodeHooks(): string {
    const config = readConfig();
    if (!config.hooks || !config.hooks.events) {
        return zcodeConfigPath();
    }
    const nextEvents: Record<string, HookEntry[]> = {};
    for (const [eventName, entries] of Object.entries(config.hooks.events)) {
        const cleaned = entriesWithoutManagedHooks(entries);
        if (cleaned.length > 0) {
            nextEvents[eventName] = cleaned;
        }
    }
    const hooks = { ...config.hooks };
    if (Object.keys(nextEvents).length > 0) {
        hooks.events = nextEvents;
    } else {
        delete hooks.events;
    }
    config.hooks = hooks;
    writeConfig(config);
    return zcodeConfigPath();
}

export function printZcodeHooks(): { path: string; events: readonly string[]; mapping: Record<string, string>; hooks: Record<string, HookEntry[]> } {
    return {
        path: zcodeConfigPath(),
        events: ZCODE_HOOK_EVENTS,
        mapping: ZCODE_EVENT_TO_AGENT_STATE,
        hooks: renderManagedHooks(),
    };
}

function renderManagedHooks(): Record<string, HookEntry[]> {
    const output: Record<string, HookEntry[]> = {};
    for (const eventName of ZCODE_HOOK_EVENTS) {
        output[eventName] = [managedHookEntry(eventName)];
    }
    return output;
}

function appendManagedHook(existing: HookEntry[], eventName: string): HookEntry[] {
    return [...existing, managedHookEntry(eventName)];
}

function managedHookEntry(eventName: string): HookEntry {
    const { command, shell } = buildHookCommand(eventName);
    return {
        hooks: [
            {
                type: 'command',
                command,
                name: `${HOOK_NAME_PREFIX}${eventName}`,
                timeout: HOOK_TIMEOUT_SEC,
                env: { ...HOOK_ENV },
                shell,
            },
        ],
    };
}

function entriesWithoutManagedHooks(entries: HookEntry[] | undefined): HookEntry[] {
    if (!Array.isArray(entries)) {
        return [];
    }
    return entries.flatMap((entry) => {
        const retained = Array.isArray(entry.hooks)
            ? entry.hooks.filter((hook) => !isManagedHook(hook))
            : [];
        if (retained.length === 0) {
            return [];
        }
        return [{ ...entry, hooks: retained }];
    });
}

function isManagedHook(hook: HookCommand): boolean {
    return typeof hook?.name === 'string' && hook.name.startsWith(HOOK_NAME_PREFIX);
}

export type BuildHookCommandOptions = {
    platform?: NodeJS.Platform;
    node?: string;
    entry?: string;
};

export function buildHookCommand(
    eventName: string,
    options: BuildHookCommandOptions = {},
): { command: string; shell: HookShell } {
    const platform = options.platform ?? process.platform;
    const node = options.node ?? process.execPath ?? 'node';
    const entry = options.entry ?? path.resolve(__dirname, 'index.js');
    if (platform === 'win32') {
        const command = `& ${powershellQuote(node)} ${powershellQuote(entry)} hook ${powershellQuote(eventName)}`;
        return { command, shell: 'powershell' };
    }
    const command = `${shellQuote(node)} ${shellQuote(entry)} hook ${shellQuote(eventName)}`;
    return { command, shell: 'bash' };
}

function readConfig(): ZcodeConfig {
    const text = readHooksText().trim();
    if (!text) {
        return {};
    }
    try {
        const parsed = JSON.parse(text) as ZcodeConfig;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot parse ZCode config JSON at ${zcodeConfigPath()}: ${message}`);
    }
}

function writeConfig(config: ZcodeConfig): void {
    writeHooksText(`${JSON.stringify(config, null, 2)}\n`);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
