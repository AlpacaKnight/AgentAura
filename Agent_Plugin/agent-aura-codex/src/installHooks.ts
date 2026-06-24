import * as path from 'path';
import { codexHooksPath, readHooksDocument, writeHooksDocument } from './config';
import { CODEX_HOOK_EVENTS } from './hooks';

interface CodexCommandHook {
    type?: string;
    command?: string;
    [key: string]: unknown;
}

interface CodexHookGroup {
    hooks?: CodexCommandHook[];
    [key: string]: unknown;
}

interface CodexHooksFile {
    hooks?: Record<string, CodexHookGroup[]>;
    [key: string]: unknown;
}

const MARKER = 'AGENTAURA_CODEX_HOOK=1';

export function installCodexHooks(): string {
    const document = normalizeHooksFile(readHooksDocument());
    removeAgentAuraHooks(document);

    for (const eventName of CODEX_HOOK_EVENTS) {
        const groups = document.hooks[eventName] || [];
        groups.push({
            hooks: [
                {
                    type: 'command',
                    command: buildHookCommand(eventName),
                },
            ],
        });
        document.hooks[eventName] = groups;
    }

    writeHooksDocument(document);
    return codexHooksPath();
}

export function uninstallCodexHooks(): string {
    const document = normalizeHooksFile(readHooksDocument());
    removeAgentAuraHooks(document);
    writeHooksDocument(document);
    return codexHooksPath();
}

export function printCodexHooks(): CodexHooksFile {
    const document: CodexHooksFile = { hooks: {} };
    for (const eventName of CODEX_HOOK_EVENTS) {
        document.hooks![eventName] = [
            {
                hooks: [
                    {
                        type: 'command',
                        command: buildHookCommand(eventName),
                    },
                ],
            },
        ];
    }
    return document;
}

function buildHookCommand(eventName: string): string {
    const entry = path.resolve(__dirname, 'index.js');
    if (process.platform === 'win32') {
        return `set ${MARKER}&& node "${entry.replace(/"/g, '\\"')}" hook "${eventName}" >nul 2>nul`;
    }
    return `${MARKER} node ${shellQuote(entry)} hook ${shellQuote(eventName)} >/dev/null 2>&1 || true`;
}

function normalizeHooksFile(value: unknown): CodexHooksFile & { hooks: Record<string, CodexHookGroup[]> } {
    const document = value && typeof value === 'object' ? value as CodexHooksFile : { hooks: {} };
    if (!document.hooks || typeof document.hooks !== 'object') {
        document.hooks = {};
    }
    for (const [eventName, groups] of Object.entries(document.hooks)) {
        if (!Array.isArray(groups)) {
            document.hooks[eventName] = [];
        }
    }
    return document as CodexHooksFile & { hooks: Record<string, CodexHookGroup[]> };
}

function removeAgentAuraHooks(document: CodexHooksFile & { hooks: Record<string, CodexHookGroup[]> }): void {
    for (const [eventName, groups] of Object.entries(document.hooks)) {
        const cleaned = groups
            .map((group) => ({
                ...group,
                hooks: Array.isArray(group.hooks)
                    ? group.hooks.filter((hook) => !isAgentAuraHook(hook))
                    : group.hooks,
            }))
            .filter((group) => !Array.isArray(group.hooks) || group.hooks.length > 0);

        if (cleaned.length > 0) {
            document.hooks[eventName] = cleaned;
        } else {
            delete document.hooks[eventName];
        }
    }
}

function isAgentAuraHook(hook: CodexCommandHook): boolean {
    const command = hook?.command || '';
    return command.includes(MARKER)
        || command.includes('agent-aura-codex')
        || command.includes('agentaura-codex');
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}