import { RingLightClient } from './deviceClient';
import { loadConfig } from './config';
import { AgentState, isAgentState } from './types';

export const CODEX_HOOK_EVENTS = [
    'UserPromptSubmit',
    'PreToolUse',
    'PostToolUse',
    'PermissionRequest',
    'Stop',
] as const;

export const CODEX_EVENT_TO_AGENT_STATE: Record<string, AgentState> = {
    UserPromptSubmit: 'running',
    PreToolUse: 'busy',
    PostToolUse: 'running',
    PermissionRequest: 'waiting',
    Stop: 'idle',
    SessionStart: 'init',
    SessionEnd: 'offline',
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

        timer = setTimeout(finish, 120);
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
        if ((normalizedKey.includes('permission') || normalizedKey.includes('approval')) && Boolean(value)) {
            return true;
        }
        if (typeof value === 'string') {
            const lowered = value.toLowerCase();
            return lowered === 'pending' || lowered === 'waiting' || lowered === 'approval_required';
        }
        return false;
    });
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