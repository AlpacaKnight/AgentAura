import * as path from 'path';
import { qwenSettingsPath, readHooksText, writeHooksText } from './config';
import { QWEN_EVENT_TO_AGENT_STATE, QWEN_HOOK_EVENTS } from './hooks';

const HOOK_NAME_PREFIX = 'agent-aura-qwencode:';
const HOOK_TIMEOUT_MS = 15_000;
const HOOK_ENV: Record<string, string> = { AGENTAURA_QWENCODE_HOOK: '1' };

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

type QwenSettings = {
    hooks?: Record<string, HookEntry[]>;
    [key: string]: unknown;
};

export function installQwenHooks(): string {
    const settings = readSettings();
    const hooks = { ...(settings.hooks || {}) };
    for (const eventName of QWEN_HOOK_EVENTS) {
        hooks[eventName] = appendManagedHook(entriesWithoutManagedHooks(hooks[eventName]), eventName);
    }
    settings.hooks = hooks;
    writeSettings(settings);
    return qwenSettingsPath();
}

export function uninstallQwenHooks(): string {
    const settings = readSettings();
    if (!settings.hooks) {
        return qwenSettingsPath();
    }
    const nextHooks: Record<string, HookEntry[]> = {};
    for (const [eventName, entries] of Object.entries(settings.hooks)) {
        const cleaned = entriesWithoutManagedHooks(entries);
        if (cleaned.length > 0) {
            nextHooks[eventName] = cleaned;
        }
    }
    if (Object.keys(nextHooks).length > 0) {
        settings.hooks = nextHooks;
    } else {
        delete settings.hooks;
    }
    writeSettings(settings);
    return qwenSettingsPath();
}

export function printQwenHooks(): { path: string; events: readonly string[]; mapping: Record<string, string>; hooks: Record<string, HookEntry[]> } {
    return {
        path: qwenSettingsPath(),
        events: QWEN_HOOK_EVENTS,
        mapping: QWEN_EVENT_TO_AGENT_STATE,
        hooks: renderManagedHooks(),
    };
}

function renderManagedHooks(): Record<string, HookEntry[]> {
    const output: Record<string, HookEntry[]> = {};
    for (const eventName of QWEN_HOOK_EVENTS) {
        output[eventName] = [managedHookEntry(eventName)];
    }
    return output;
}

function appendManagedHook(existing: HookEntry[], eventName: string): HookEntry[] {
    return [...existing, managedHookEntry(eventName)];
}

function managedHookEntry(eventName: string): HookEntry {
    const matcher = matcherForEvent(eventName);
    const { command, shell } = buildHookCommand(eventName);
    const entry: HookEntry = {
        hooks: [
            {
                type: 'command',
                command,
                name: `${HOOK_NAME_PREFIX}${eventName}`,
                timeout: HOOK_TIMEOUT_MS,
                env: { ...HOOK_ENV },
                shell,
            },
        ],
    };
    if (matcher) {
        entry.matcher = matcher;
    }
    return entry;
}

function matcherForEvent(eventName: string): string | undefined {
    if (eventName === 'Notification') {
        return 'permission_prompt';
    }
    return undefined;
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

function readSettings(): QwenSettings {
    const text = readHooksText().trim();
    if (!text) {
        return {};
    }
    try {
        const parsed = JSON.parse(text) as QwenSettings;
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot parse Qwen Code settings JSON at ${qwenSettingsPath()}: ${message}`);
    }
}

function writeSettings(settings: QwenSettings): void {
    writeHooksText(`${JSON.stringify(settings, null, 2)}\n`);
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
}

function powershellQuote(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
}
