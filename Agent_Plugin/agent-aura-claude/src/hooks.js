'use strict';

const { loadConfig } = require('./config');
const { RingLightClient } = require('./deviceClient');
const { isAgentState } = require('./types');

const STDIN_READ_TIMEOUT_MS = 1000;

const CLAUDE_HOOK_EVENTS = [
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
];

const CLAUDE_EVENT_TO_AGENT_STATE = {
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

async function runClaudeHook(eventArg) {
  try {
    const payload = await readStdinJson();
    const eventName = normalizeClaudeEventName(eventArg || '', payload) || 'Unknown';
    const state = mapClaudeEventToAgentState(eventName, payload);
    await new RingLightClient(loadConfig()).sendAgentState(state);
  } catch {
    // Hook commands must never break Claude Code execution.
  }
}

function mapClaudeEventToAgentState(eventName, payload) {
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

function normalizeClaudeEventName(eventArg, payload) {
  if (eventArg.trim()) {
    return eventArg.trim();
  }
  if (!payload || typeof payload !== 'object') {
    return '';
  }
  const record = payload;
  for (const key of ['hook_event_name', 'hookEventName', 'event', 'type', 'name', 'hook']) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return '';
}

async function readStdinJson() {
  if (process.stdin.isTTY) {
    return undefined;
  }

  const text = await new Promise((resolve) => {
    let buffer = '';
    let settled = false;
    let timer;
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
    const onData = (chunk) => {
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

function payloadSignalsError(payload) {
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

function payloadSignalsWaiting(payload) {
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

function waitingSignalKey(normalizedKey) {
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

function mapNotificationToAgentState(payload) {
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

function collectStringValues(value, depth = 0) {
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
    return Object.values(value).flatMap((item) => collectStringValues(item, depth + 1));
  }
  return [];
}

function inspectPayload(payload, predicate, depth = 0) {
  if (!payload || depth > 4) {
    return false;
  }
  if (Array.isArray(payload)) {
    return payload.some((item) => inspectPayload(item, predicate, depth + 1));
  }
  if (typeof payload !== 'object') {
    return false;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (predicate(key, value)) {
      return true;
    }
    if (inspectPayload(value, predicate, depth + 1)) {
      return true;
    }
  }
  return false;
}

module.exports = {
  CLAUDE_HOOK_EVENTS,
  CLAUDE_EVENT_TO_AGENT_STATE,
  runClaudeHook,
  mapClaudeEventToAgentState,
  normalizeClaudeEventName,
  readStdinJson,
  waitingSignalKey,
};
