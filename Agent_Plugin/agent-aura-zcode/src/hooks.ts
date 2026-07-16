import { clearHookSuppression, hooksSuppressed, loadConfig, loadRuntimeState, saveRuntimeState, suppressHooks } from './config';
import { RingLightClient } from './deviceClient';
import { AgentState, SendContext, isAgentState } from './types';

const STDIN_READ_TIMEOUT_MS = 1000;

/**
 * ZCode 支持的 hook 事件（恰好 7 个）。
 * 不支持 Notification、SubagentStart/Stop、PreCompact、SessionEnd 等。
 */
export const ZCODE_HOOK_EVENTS = [
    'SessionStart',
    'UserPromptSubmit',
    'PreToolUse',
    'PermissionRequest',
    'PostToolUse',
    'PostToolUseFailure',
    'Stop',
] as const;

export const ZCODE_EVENT_TO_AGENT_STATE: Record<string, AgentState> = {
    SessionStart: 'init',
    UserPromptSubmit: 'running',
    PreToolUse: 'busy',
    PermissionRequest: 'waiting',
    PostToolUse: 'running',
    PostToolUseFailure: 'error',
    Stop: 'idle',
};

export async function runZcodeHook(eventArg?: string): Promise<void> {
    try {
        const payload = await readStdinJson();
        const eventName = normalizeZcodeEventName(eventArg || '', payload) || 'Unknown';
        if (shouldSkipZcodeHook(eventName, payload)) {
            return;
        }
        const sessionId = extractSessionId(payload);
        if (sessionId) {
            const runtime = loadRuntimeState();
            saveRuntimeState({ ...runtime, lastSessionId: sessionId });
        }
        const state = mapZcodeEventToAgentState(eventName, payload);
        const context: SendContext | undefined = sessionId ? { sessionId } : undefined;
        const client = new RingLightClient(loadConfig());
        const ok = await client.sendAgentState(state, context);
        // 发送 Hook 事件摘要到桌宠气泡（失败静默，绝不打断 ZCode）。
        // idle 也允许发送，因为 Stop 事件需要显示"任务已完成"。
        if (ok) {
            const message = buildZcodeMessage(eventName, state, payload);
            if (message) {
                await client.sendMessage(message.text, message.kind, message.priority, message.ttlMs, context).catch(() => {});
            }
        }
    } catch {
        // Hook commands must never break ZCode execution.
    }
}

export function shouldSkipZcodeHook(eventName: string, payload: unknown): boolean {
    if (payloadContainsAgentAuraCommand(payload)) {
        suppressHooks(undefined, 'agent-aura slash command');
        return true;
    }
    if (eventName === 'SessionStart' || eventName === 'UserPromptSubmit') {
        clearHookSuppression();
        return false;
    }
    if (hooksSuppressed()) {
        return true;
    }
    return false;
}

export function mapZcodeEventToAgentState(eventName: string, payload?: unknown): AgentState {
    const normalized = eventName.trim();
    const lowered = normalized.toLowerCase();

    if (isAgentState(lowered)) {
        return lowered;
    }
    if (payloadSignalsError(payload)) {
        return 'error';
    }

    const direct = ZCODE_EVENT_TO_AGENT_STATE[normalized];
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
    if (lowered.includes('pretool') || lowered.includes('toolstart')) {
        return 'busy';
    }
    if (lowered.includes('posttool') || lowered.includes('toolend')) {
        return 'running';
    }
    if (lowered.includes('stop') || lowered.includes('done') || lowered.includes('complete') || lowered.includes('idle')) {
        return 'idle';
    }
    return 'running';
}

type BubbleKind = 'state' | 'activity' | 'success' | 'warning' | 'error';

interface BubbleMessage {
    text: string;
    kind: BubbleKind;
    priority?: number;
    ttlMs?: number;
}

/** 从 Hook payload 中递归探测工具名称（深度上限 4）。 */
export function extractToolName(payload: unknown): string | undefined {
    return findInPayload(payload, (key, value) => {
        if (typeof value !== 'string') return undefined;
        const k = key.toLowerCase();
        if (k === 'tool_name' || k === 'toolname' || k === 'tool') {
            return value;
        }
        return undefined;
    });
}

function findInPayload(payload: unknown, visitor: (key: string, value: unknown) => string | undefined, depth = 0): string | undefined {
    if (!payload || depth > 4) return undefined;
    if (Array.isArray(payload)) {
        for (const item of payload) {
            const found = findInPayload(item, visitor, depth + 1);
            if (found) return found;
        }
        return undefined;
    }
    if (typeof payload !== 'object') return undefined;
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        const found = visitor(key, value);
        if (found) return found;
        if (typeof value === 'object' && value !== null) {
            const nested = findInPayload(value, visitor, depth + 1);
            if (nested) return nested;
        }
    }
    return undefined;
}

/** 根据 Hook 事件构建桌宠气泡消息摘要。返回 undefined 表示不发消息。 */
export function buildZcodeMessage(eventName: string, state: AgentState, payload?: unknown): BubbleMessage | undefined {
    const normalized = eventName.trim();
    const toolName = extractToolName(payload);
    const tool = toolName || '工具';

    switch (normalized) {
        case 'PreToolUse':
            return { text: `正在运行 ${tool}`, kind: 'activity' };
        case 'PermissionRequest':
            return { text: `${tool} 等待授权`, kind: 'warning', priority: 60 };
        case 'PostToolUse':
            if (payloadSignalsError(payload)) {
                const summary = extractErrorSummary(payload);
                return { text: summary || `${tool} 执行出错`, kind: 'error', priority: 80 };
            }
            return { text: `${tool} 已完成`, kind: 'success' };
        case 'PostToolUseFailure':
            return { text: extractErrorSummary(payload) || `${tool} 执行出错`, kind: 'error', priority: 80 };
        case 'Stop':
            return { text: '任务已完成', kind: 'success' };
        default:
            return undefined;
    }
}

function normalizeZcodeEventName(eventArg: string, payload?: unknown): string {
    if (eventArg.trim()) {
        return eventArg.trim();
    }
    if (!payload || typeof payload !== 'object') {
        return '';
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['hook_event_name', 'hookEventName', 'event', 'type', 'name', 'hook']) {
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

    const text: string = await new Promise<string>((resolve) => {
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
        if (normalizedKey.includes('permissiondecision') && typeof value === 'string') {
            return value.toLowerCase() === 'deny';
        }
        if ((normalizedKey.includes('error') || normalizedKey.includes('denied')) && Boolean(value)) {
            return true;
        }
        if (typeof value === 'string') {
            const lowered = value.toLowerCase();
            return lowered === 'denied'
                || lowered === 'rejected'
                || lowered === 'failed'
                || lowered === 'failure'
                || lowered === 'error'
                || lowered === 'deny';
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
                || lowered === 'permission_prompt';
        }
        return false;
    });
}

function waitingSignalKey(normalizedKey: string): boolean {
    if (!(normalizedKey.includes('permission') || normalizedKey.includes('approval'))) {
        return false;
    }
    if (normalizedKey === 'permission_mode' || normalizedKey === 'permissionmode') {
        return false;
    }
    return normalizedKey.includes('prompt')
        || normalizedKey.includes('pending')
        || normalizedKey.includes('required')
        || normalizedKey.includes('request');
}

/** 从 Hook payload 中提取错误摘要（截断清理）。
 *  注意：不匹配 'message' 字段，因为 ZCode 的 payload 中 'message'
 *  是顶层会话消息而非错误。只匹配明确与错误相关的字段名。 */
function extractErrorSummary(payload: unknown): string | undefined {
    const result = findInPayload(payload, (key, value) => {
        if (typeof value !== 'string') return undefined;
        const k = key.toLowerCase();
        if (k === 'error' || k === 'error_message' || k === 'errormessage' || k === 'stderr' || k === 'reason' || k === 'detail' || k === 'details') {
            return value;
        }
        return undefined;
    });
    if (!result) return undefined;
    return result.replace(/\s+/g, ' ').trim().slice(0, 100) || undefined;
}

function extractSessionId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== 'object') {
        return undefined;
    }
    const record = payload as Record<string, unknown>;
    for (const key of ['session_id', 'sessionId']) {
        const value = record[key];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return undefined;
}

export function payloadContainsAgentAuraCommand(payload: unknown): boolean {
    return collectStringValues(payload).some((value) => {
        const trimmed = value.trim();
        return trimmed.startsWith('/agent-aura-zcode:aura')
            || trimmed.startsWith('agent-aura-zcode:aura');
    });
}

function collectStringValues(value: unknown, depth = 0): string[] {
    if (value === null || value === undefined || depth > 3) {
        return [];
    }
    if (typeof value === 'string') {
        return [value];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => collectStringValues(item, depth + 1));
    }
    if (typeof value === 'object') {
        return Object.values(value as Record<string, unknown>).flatMap((item) => collectStringValues(item, depth + 1));
    }
    return [];
}

function inspectPayload(value: unknown, predicate: (key: string, value: unknown) => boolean, depth = 0): boolean {
    if (value === null || value === undefined || depth > 4) {
        return false;
    }
    if (Array.isArray(value)) {
        return value.some((item) => inspectPayload(item, predicate, depth + 1));
    }
    if (typeof value !== 'object') {
        return false;
    }
    return Object.entries(value as Record<string, unknown>).some(([key, nested]) => predicate(key, nested) || inspectPayload(nested, predicate, depth + 1));
}
