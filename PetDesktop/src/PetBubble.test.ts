import { describe, expect, it } from 'vitest';
import { selectBubbleMessage } from './PetBubble';
import { STATE_TEMPLATES, type AppSnapshot, type PetBubbleSettings } from './types';

function snapshot(overrides: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    version: 'test',
    effectiveState: 'idle',
    effectiveAgentId: undefined,
    lockedAgentId: undefined,
    paused: false,
    agents: [],
    pets: [],
    selectedPet: undefined,
    settings: {
      selectedPetId: 'builtin-aura',
      petScale: 1,
      alwaysOnTop: true,
      roamEnabled: false,
      roamIntervalSeconds: 30,
      roamSpeed: 80,
      clickThrough: false,
      petVisible: true,
      showOnAllWorkspaces: false,
      launchAtStartup: false,
      lanEnabled: false,
      lanToken: '',
      hardware: { transport: 'disabled', host: '', port: 80, serialPort: '', baud: 115200, autoDiscover: true },
      petBubble: bubbleSettings({}),
    },
    hardware: { connected: false, syncing: false },
    logs: [],
    petMessages: [],
    ...overrides,
  };
}

function bubbleSettings(overrides: Partial<PetBubbleSettings> = {}): PetBubbleSettings {
  return { enabled: true, mode: 'both', durationSeconds: 5, maxCharacters: 140, fontScale: 1, showSource: false, ...overrides };
}

function message(text: string, createdAt: string, ttlMs = 5000, priority = 20, kind: AppSnapshot['petMessages'][number]['kind'] = 'activity') {
  return { id: text, agentInstanceId: undefined, kind, text, source: 'codex', priority, createdAt, ttlMs };
}

describe('PetBubble message selection', () => {
  it('shows state template when no event messages (both mode)', () => {
    const snap = snapshot({ effectiveState: 'running' });
    const result = selectBubbleMessage(snap, bubbleSettings());
    expect(result?.text).toBe(STATE_TEMPLATES.running);
    expect(result?.kind).toBe('state');
    expect(result?.expiresAt).toBe(Infinity);
  });

  it('shows state template in state-only mode even with events present', () => {
    const now = new Date().toISOString();
    const snap = snapshot({ effectiveState: 'idle', petMessages: [message('正在运行 cargo test', now)] });
    const result = selectBubbleMessage(snap, bubbleSettings({ mode: 'state' }));
    expect(result?.text).toBe(STATE_TEMPLATES.idle);
  });

  it('shows event message in both mode (events take priority over template)', () => {
    const now = new Date().toISOString();
    const snap = snapshot({ effectiveState: 'busy', petMessages: [message('正在运行 cargo test', now)] });
    const result = selectBubbleMessage(snap, bubbleSettings());
    expect(result?.text).toBe('正在运行 cargo test');
    expect(result?.kind).toBe('activity');
  });

  it('shows nothing in events-only mode when no events exist', () => {
    const snap = snapshot({ effectiveState: 'idle' });
    const result = selectBubbleMessage(snap, bubbleSettings({ mode: 'events' }));
    expect(result).toBeUndefined();
  });

  it('picks highest priority event when multiple exist', () => {
    const now = new Date().toISOString();
    const snap = snapshot({
      petMessages: [
        message('正在运行工具', now, 5000, 20, 'activity'),
        message('操作出现错误', now, 5000, 80, 'error'),
      ],
    });
    const result = selectBubbleMessage(snap, bubbleSettings());
    expect(result?.text).toBe('操作出现错误');
    expect(result?.kind).toBe('error');
  });

  it('truncates long text to maxCharacters with ellipsis', () => {
    const long = 'A'.repeat(300);
    const now = new Date().toISOString();
    const snap = snapshot({ petMessages: [message(long, now)] });
    const result = selectBubbleMessage(snap, bubbleSettings({ maxCharacters: 10 }));
    expect(result?.text).toBe('AAAAAAAAAA…');
    expect(result?.text.length).toBe(11);
  });

  it('filters out expired messages', () => {
    const old = new Date(Date.now() - 10_000).toISOString();
    const snap = snapshot({ effectiveState: 'idle', petMessages: [message('旧消息', old, 1000)] });
    const result = selectBubbleMessage(snap, bubbleSettings({ mode: 'events' }));
    expect(result).toBeUndefined();
  });

  it('renders text as plain text, not HTML (no dangerouslySetInnerHTML)', () => {
    const now = new Date().toISOString();
    const snap = snapshot({ petMessages: [message('<img src=x onerror=alert(1)>', now)] });
    const result = selectBubbleMessage(snap, bubbleSettings());
    // 文本是原始字符串，未被解析为 HTML —— React 会以文本节点渲染。
    expect(result?.text).toBe('<img src=x onerror=alert(1)>');
  });

  it('includes source when showSource is enabled', () => {
    const now = new Date().toISOString();
    const snap = snapshot({
      effectiveState: 'busy',
      effectiveAgentId: 'codex-main',
      agents: [{ instanceId: 'codex-main', clientId: 'codex', displayName: 'Codex', state: 'busy', connected: true, lastSeenMs: 0, lastSeenAt: '' }],
      petMessages: [message('正在运行 cargo test', now)],
    });
    const result = selectBubbleMessage(snap, bubbleSettings({ showSource: true }));
    expect(result?.source).toBe('Codex');
  });

  it('state templates cover all agent states', () => {
    const states: AppSnapshot['effectiveState'][] = ['init', 'running', 'busy', 'waiting', 'idle', 'error', 'offline', 'upgrade'];
    for (const state of states) {
      const snap = snapshot({ effectiveState: state });
      const result = selectBubbleMessage(snap, bubbleSettings());
      expect(result?.text).toBe(STATE_TEMPLATES[state]);
    }
  });
});
