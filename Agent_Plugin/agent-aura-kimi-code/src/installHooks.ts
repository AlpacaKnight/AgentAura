import * as path from 'path';
import { kimiHooksPath, readHooksText, writeHooksText } from './config';
import { KIMI_EVENT_TO_AGENT_STATE, KIMI_HOOK_EVENTS } from './hooks';

const BEGIN_MARKER = '# BEGIN AGENTAURA_KIMI_CODE_HOOKS';
const END_MARKER = '# END AGENTAURA_KIMI_CODE_HOOKS';
const MARKER = 'AGENTAURA_KIMI_CODE_HOOK=1';

export function installKimiHooks(): string {
    const existing = stripAgentAuraHooks(readHooksText());
    const next = mergeHookBlock(existing, renderHookBlock());
    writeHooksText(next);
    return kimiHooksPath();
}

export function uninstallKimiHooks(): string {
    const existing = stripAgentAuraHooks(readHooksText());
    writeHooksText(normalizeTrailingNewline(existing));
    return kimiHooksPath();
}

export function printKimiHooks(): { path: string; events: readonly string[]; mapping: Record<string, string>; block: string } {
    return {
        path: kimiHooksPath(),
        events: KIMI_HOOK_EVENTS,
        mapping: KIMI_EVENT_TO_AGENT_STATE,
        block: renderHookBlock(),
    };
}

function renderHookBlock(): string {
    const lines = [BEGIN_MARKER];
    for (const eventName of KIMI_HOOK_EVENTS) {
        lines.push('[[hooks]]');
        lines.push(`event = ${tomlBasicString(eventName)}`);
        lines.push(`command = ${tomlBasicString(buildHookCommand(eventName))}`);
        lines.push('timeout = 5');
        lines.push('');
    }
    lines.push(END_MARKER);
    return `${lines.join('\n')}\n`;
}

function mergeHookBlock(existing: string, block: string): string {
    const trimmed = existing.replace(/\s+$/u, '');
    if (!trimmed) {
        return block;
    }
    return `${trimmed}\n\n${block}`;
}

function stripAgentAuraHooks(text: string): string {
    return text.replace(new RegExp(`${escapeRegExp(BEGIN_MARKER)}[\\s\\S]*?${escapeRegExp(END_MARKER)}\\s*`, 'gu'), '').replace(/\s+$/u, '');
}

function buildHookCommand(eventName: string): string {
    const node = process.execPath || 'node';
    const entry = path.resolve(__dirname, 'index.js');
    if (process.platform === 'win32') {
        return `set ${MARKER}&& ${windowsQuote(node)} ${windowsQuote(entry)} hook ${windowsQuote(eventName)} >nul 2>nul`;
    }
    return `${MARKER} ${shellQuote(node)} ${shellQuote(entry)} hook ${shellQuote(eventName)} >/dev/null 2>&1 || true`;
}

function tomlBasicString(value: string): string {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function normalizeTrailingNewline(text: string): string {
    if (!text.trim()) {
        return '';
    }
    return `${text.trimEnd()}\n`;
}

function windowsQuote(value: string): string {
    return `"${value.replace(/"/g, '\\"')}"`;
}

function shellQuote(value: string): string {
    return `'${value.replace(/'/g, `'\\''`)}'`;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
