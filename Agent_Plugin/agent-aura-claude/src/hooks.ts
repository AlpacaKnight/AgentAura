'use strict';

import { clearHookSuppression, hooksSuppressed, loadConfig, suppressHooks } from './config';
import { RingLightClient } from './deviceClient';
import { isAgentState, type AgentState } from './types';

const STDIN_READ_TIMEOUT_MS = 1000;

export const CLAUDE_HOOK_EVENTS = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PermissionRequest',
  'PermissionDenied',
  'PostToolUse',
  'PostToolUseFailure',
  'PostToolBatch',
  'Notification',
  'SubagentStart',
  'SubagentStop',
  'TaskCreated',
  'TaskCompleted',
  'PreCompact',
  'PostCompact',
  'Stop',
  'StopFailure',
  'SessionEnd',
] as const;

export const CLAUDE_EVENT_TO_AGENT_STATE: Record<string, AgentState> = {
  SessionStart: 'init',
  Setup: 'init',
  UserPromptSubmit: 'running',
  PreToolUse: 'busy',
  PermissionRequest: 'waiting',
  PermissionDenied: 'error',
  PostToolUse: 'running',
  PostToolUseFailure: 'error',
  PostToolBatch: 'running',
  SubagentStart: 'busy',
  SubagentStop: 'running',
  TaskCreated: 'busy',
  TaskCompleted: 'running',
  PreCompact: 'busy',
  PostCompact: 'running',
  Stop: 'idle',
  StopFailure: 'error',
  TeammateIdle: 'idle',
  SessionEnd: 'offline',
};

export async function runClaudeHook(eventArg: string): Promise<void> {
  try {
    const payload = await readStdinJson();
    const eventName = normalizeClaudeEventName(eventArg || '', payload) || 'Unknown';
    if (shouldSkipClaudeHook(eventName, payload)) {
      return;
    }
    const state = mapClaudeEventToAgentState(eventName, payload);
    const client = new RingLightClient(loadConfig());
    const ok = await client.sendAgentState(state);
    if (ok) {
      // 发送 Hook 事件摘要到桌宠气泡（失败静默，绝不打断 Claude Code）。
      const message = buildClaudeMessage(eventName, state, payload);
      if (message) {
        await client.sendMessage(message.text, message.kind, message.priority, message.ttlMs).catch(() => {});
      }
    }
  } catch {
    // Hook commands must never break Claude Code execution.
  }
}

export function shouldSkipClaudeHook(eventName: string, payload: unknown): boolean {
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

export function mapClaudeEventToAgentState(eventName: string, payload: unknown): AgentState {
  const normalized = eventName.trim();
  const lowered = normalized.toLowerCase();

  if (isAgentState(lowered)) {
    return lowered;
  }
  if (payloadSignalsError(payload)) {
    return 'error';
  }
  if (normalized === 'Notification') {
    return mapNotificationToAgentState(payload) || 'running';
  }

  const direct = CLAUDE_EVENT_TO_AGENT_STATE[normalized];
  if (direct) {
    return direct;
  }
  if (payloadSignalsWaiting(payload)) {
    return 'waiting';
  }
  if (lowered.includes('permission') || lowered.includes('approval') || lowered.includes('elicitation')) {
    return 'waiting';
  }
  if (lowered.includes('error') || lowered.includes('fail') || lowered.includes('deny')) {
    return 'error';
  }
  if (lowered.includes('pretool') || lowered.includes('toolstart') || lowered.includes('subagentstart')) {
    return 'busy';
  }
  if (lowered.includes('posttool') || lowered.includes('toolend') || lowered.includes('subagentstop')) {
    return 'running';
  }
  if (lowered.includes('stop') || lowered.includes('done') || lowered.includes('complete') || lowered.includes('idle')) {
    return 'idle';
  }
  return 'running';
}

export function normalizeClaudeEventName(eventArg: string, payload: unknown): string {
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

export async function readStdinJson(): Promise<unknown> {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const text: string = await new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      process.stdin.off('data', onData);
      process.stdin.off('end', finish);
      process.stdin.pause();
      resolve(buffer);
    };
    const onData = (chunk: string) => {
      buffer += chunk;
    };

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
      return lowered === 'denied'
        || lowered === 'rejected'
        || lowered === 'failed'
        || lowered === 'failure'
        || lowered === 'error';
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

export function waitingSignalKey(normalizedKey: string): boolean {
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

function mapNotificationToAgentState(payload: unknown): AgentState | null {
  const values = collectStringValues(payload).map((value) => value.toLowerCase());
  if (values.some((value) => value.includes('permission_prompt') || value.includes('elicitation_dialog'))) {
    return 'waiting';
  }
  if (values.some((value) => value.includes('idle_prompt'))) {
    return 'idle';
  }
  if (values.some((value) => value.includes('auth_success') || value.includes('elicitation_complete') || value.includes('elicitation_response'))) {
    return 'running';
  }
  return null;
}

export function payloadContainsAgentAuraCommand(payload: unknown): boolean {
  return collectStringValues(payload).some((value) => {
    const trimmed = value.trim();
    return trimmed.startsWith('/agent-aura-claude:aura')
      || trimmed.startsWith('agent-aura-claude:aura');
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

function inspectPayload(payload: unknown, predicate: (key: string, value: unknown) => boolean, depth = 0): boolean {
  if (!payload || depth > 4) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((item) => inspectPayload(item, predicate, depth + 1));
  }
  if (typeof payload !== 'object') {
    return false;
  }
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (predicate(key, value)) {
      return true;
    }
    if (inspectPayload(value, predicate, depth + 1)) {
      return true;
    }
  }
  return false;
}

type BubbleKind = 'state' | 'activity' | 'success' | 'warning' | 'error';

interface BubbleMessage {
  text: string;
  kind: BubbleKind;
  priority?: number;
  ttlMs?: number;
}

/** 从 Hook payload 中递归探测工具名称（深度上限 4）。 */
function extractToolName(payload: unknown): string | undefined {
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

/** 从 Hook payload 中提取错误摘要（截断清理）。 */
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

/** 根据 Hook 事件构建桌宠气泡消息摘要。返回 undefined 表示不发消息。 */
export function buildClaudeMessage(eventName: string, state: AgentState, payload?: unknown): BubbleMessage | undefined {
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
      return { text: `${tool} 执行出错`, kind: 'error', priority: 80 };
    default:
      return undefined;
  }
}
