import { RingLightClient } from './deviceClient';
import { loadConfig } from './config';
import { AgentState, isAgentState } from './types';

const STDIN_READ_TIMEOUT_MS = 1000;

export const CODEX_HOOK_EVENTS = [
    'SessionStart',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PreCompact',
    'PostCompact',
    'SubagentStart',
    'SubagentStop',
] as const;

export const CODEX_EVENT_TO_AGENT_STATE: Record<string, AgentState> = {
    SessionStart: 'init',
    PreToolUse: 'busy',
    PermissionRequest: 'waiting',
    PostToolUse: 'running',
    PreCompact: 'busy',
    PostCompact: 'running',
    SubagentStart: 'busy',
    SubagentStop: 'running',
};

export async function runCodexHook(eventArg?: string): Promise<void> {
    try {
        const payload = await readStdinJson();
        const eventName = normalizeCodexEventName(eventArg || '', payload) || 'Unknown';
        const state = mapCodexEventToAgentState(eventName, payload);
        await new RingLightClient(loadConfig()).sendAgentState(state);
    } catch {
        // Hook commands must never break Codex execution.
    }
}

export function mapCodexEventToAgentState(eventName: string, payload?: unknown): AgentState {
    const normalized = eventName.trim();
    const lowered = normalized.toLowerCase();

    if (isAgentState(lowered)) {
        return lowered;
    }
    if (payloadSignalsError(payload)) {
        return 'error';
    }

    const direct = CODEX_EVENT_TO_AGENT_STATE[normalized];
    if (direct) {
        return direct;
    }
    if (payloadSignalsWaiting(payload)) {
        return 'waiting';
    }
    if (lowered.includes('permission') || lowered.includes('approval') || lowered.includes('confirm')) {
        return 'waiting';
    }
    if (lowered.includes('error') || lowered.includes('fail') || lowered.includes('deny')) {
        return 'error';
    }
    if (lowered.includes('pretool') || lowered.includes('toolstart') || lowered.includes('tool_use')) {
        return 'busy';
    }
    if (lowered.includes('posttool') || lowered.includes('toolend')) {
        return 'running';
    }
    if (lowered.includes('stop') || lowered.includes('done') || lowered.includes('complete')) {
        return 'idle';
    }
    return 'running';
}

function normalizeCodexEventName(eventArg: string, payload?: unknown): string {
    if (eventArg.trim()) {
        return eventArg.trim();
    }
    if (!payload || typeof payload !== 'object') {
        return '';
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['hook_event_name', 'event', 'type', 'name', 'hook']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return '';
}

async function readStdinJson(): Promise<unknown | undefined> {
    if (process.stdin.isTTY) {
        return undefined;
    }

    const text = await new Promise<string>((resolve) => {
        let buffer = '';
        let settled = false;
        let timer: NodeJS.Timeout;
        const finish = () => {
            if (settled) { return; }
            settled = true;
            clearTimeout(timer);
            process.stdin.off('data', onData);
            process.stdin.off('end', finish);
            process.stdin.pause();
            resolve(buffer);
        };
        const onData = (chunk: string) => buffer += chunk;

        timer = setTimeout(finish, STDIN_READ_TIMEOUT_MS);
        timer.unref?.();

        process.stdin.setEncoding('utf8');
        process.stdin.on('data', onData);
        process.stdin.on('end', finish);
        process.stdin.resume();
    });

    if (!text.trim()) {
        return undefined;
    }
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function payloadSignalsError(payload: unknown): boolean {
    return inspectPayload(payload, (key, value) => {
        const normalizedKey = key.toLowerCase();
        if ((normalizedKey === 'success' || normalizedKey === 'ok') && value === false) {
            return true;
        }
        if ((normalizedKey.includes('error') || normalizedKey.includes('denied')) && Boolean(value)) {
            return true;
        }
        if (typeof value === 'string') {
            const lowered = value.toLowerCase();
            return lowered === 'denied' || lowered === 'rejected' || lowered === 'failed' || lowered === 'error';
        }
        return false;
    });
}

function payloadSignalsWaiting(payload: unknown): boolean {
    return inspectPayload(payload, (key, value) => {
        const normalizedKey = key.toLowerCase();
        if (waitingSignalKey(normalizedKey) && Boolean(value)) {
            return true;
        }
        if (typeof value === 'string') {
            const lowered = value.toLowerCase();
            return lowered === 'pending'
                || lowered === 'waiting'
                || lowered === 'approval_required'
                || lowered === 'permission_prompt'
                || lowered === 'elicitation_dialog';
        }
        return false;
    });
}

function waitingSignalKey(normalizedKey: string): boolean {
    if (!(normalizedKey.includes('permission') || normalizedKey.includes('approval') || normalizedKey.includes('elicitation'))) {
        return false;
    }
    if (normalizedKey === 'permission_mode' || normalizedKey === 'permissionmode') {
        return false;
    }
    return normalizedKey.includes('prompt')
        || normalizedKey.includes('pending')
        || normalizedKey.includes('required')
        || normalizedKey.includes('request')
        || normalizedKey.includes('dialog');
}

function inspectPayload(payload: unknown, predicate: (key: string, value: unknown) => boolean, depth = 0): boolean {
    if (!payload || depth > 4) { return false; }
    if (Array.isArray(payload)) {
        return payload.some((item) => inspectPayload(item, predicate, depth + 1));
    }
    if (typeof payload !== 'object') { return false; }
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        if (predicate(key, value)) { return true; }
        if (inspectPayload(value, predicate, depth + 1)) { return true; }
    }
    return false;
}
