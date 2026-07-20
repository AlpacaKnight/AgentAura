import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { STATE_TEMPLATES, type AgentState, type AppSnapshot, type PetBubbleSettings, type PetMessage, type PetMessageKind } from './types';

const TTL_TICK_MS = 250;

export type PetBubbleProps = {
  snapshot: AppSnapshot;
  settings: PetBubbleSettings;
  menuOpen: boolean;
  /** 气泡内容高度（含 padding/边框，物理像素）变化时通知父组件，用于窗口尺寸计算。 */
  onHeightChange: (height: number) => void;
};

type DisplayMessage = {
  text: string;
  kind: PetMessageKind;
  source?: string;
  expiresAt: number;
};

function nowMs(): number {
  return Date.now();
}

function messageNotExpired(message: PetMessage, at: number): boolean {
  const created = Date.parse(message.createdAt);
  if (!Number.isFinite(created)) return false;
  return created + message.ttlMs > at;
}

/** 从快照与设置中选取当前应显示的消息（或 undefined 表示无）。 */
export function selectBubbleMessage(
  snapshot: AppSnapshot,
  settings: PetBubbleSettings,
  at: number = nowMs(),
): DisplayMessage | undefined {
  const mode = settings.mode;
  const stateTemplate = STATE_TEMPLATES[snapshot.effectiveState as AgentState] ?? STATE_TEMPLATES.idle;
  const agentName = snapshot.agents.find(a => a.instanceId === snapshot.effectiveAgentId)?.displayName;

  // 仅事件模式不回退状态模板。
  if (mode === 'events') {
    const events = snapshot.petMessages.filter(m => messageNotExpired(m, at));
    return pickEvent(events, at, settings, agentName);
  }

  // both：事件优先，无则回退状态模板。
  if (mode === 'both') {
    const events = snapshot.petMessages.filter(m => messageNotExpired(m, at));
    const event = pickEvent(events, at, settings, agentName);
    if (event) return event;
  }

  // state 或 both 无事件 → 状态模板。
  return {
    text: stateTemplate,
    kind: 'state',
    source: settings.showSource ? agentName : undefined,
    expiresAt: Infinity, // 状态模板不自动消失
  };
}

function pickEvent(
  events: PetMessage[],
  at: number,
  settings: PetBubbleSettings,
  agentName?: string,
): DisplayMessage | undefined {
  if (events.length === 0) return undefined;
  // 按 priority 降序、createdAt 降序取首条。
  const sorted = [...events].sort((a, b) => b.priority - a.priority || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const top = sorted[0];
  return {
    text: truncate(top.text, settings.maxCharacters),
    kind: top.kind,
    source: settings.showSource ? (agentName ?? top.source) : undefined,
    expiresAt: Date.parse(top.createdAt) + top.ttlMs,
  };
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  if (chars.length <= max) return text;
  return chars.slice(0, max).join('') + '…';
}

export default function PetBubble({ snapshot, settings, menuOpen, onHeightChange }: PetBubbleProps) {
  const [, setTick] = useState(0);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  // 周期性 tick 让 TTL 过期后重新选取消息（状态模板不过期）。
  // 右键菜单打开时暂停，避免消息在用户操作期间消失。
  useEffect(() => {
    if (!settings.enabled || menuOpen) return;
    const timer = window.setInterval(() => setTick(t => t + 1), TTL_TICK_MS);
    return () => window.clearInterval(timer);
  }, [settings.enabled, menuOpen]);

  const message = settings.enabled ? selectBubbleMessage(snapshot, settings, nowMs()) : undefined;
  const visible = Boolean(message) && (!message || message.expiresAt > nowMs());

  // 气泡高度变化时通知父组件。用 useLayoutEffect 在浏览器绘制前同步测量，
  // 避免气泡因窗口尺寸未更新而被 overflow:hidden 裁切。
  useLayoutEffect(() => {
    const el = bubbleRef.current;
    if (!el) {
      if (!visible) onHeightChange(0);
      return;
    }
    const measure = () => {
      const rect = el.getBoundingClientRect();
      onHeightChange(visible ? Math.ceil(rect.height) : 0);
    };
    // 同步首测 + ResizeObserver 追踪后续变化。
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
      // 不在 cleanup 中重置为 0，避免 visible 切换时产生闪烁。
      // visible 为 false 时 measure 已经返回 0。
    };
  }, [visible, onHeightChange]);

  // TTL 自动消失计时；右键菜单打开时暂停。
  const expiresAt = message?.expiresAt ?? Infinity;
  useEffect(() => {
    if (menuOpen || !Number.isFinite(expiresAt)) return;
    const remaining = Math.max(0, expiresAt - nowMs());
    const timer = window.setTimeout(() => setTick(t => t + 1), remaining + 16);
    return () => window.clearTimeout(timer);
  }, [expiresAt, menuOpen, message?.text]);

  const handleRef = useCallback((el: HTMLDivElement | null) => {
    bubbleRef.current = el;
    // 触发 ResizeObserver 初始测量。
    setTick(t => t + 1);
  }, []);

  if (!visible || !message) return null;

  return (
    <div className={`pet-bubble kind-${message.kind}`} role="status" aria-live="polite" ref={handleRef} style={{ fontSize: `${12 * settings.fontScale}px` }}>
      <span className="pet-bubble-text">{message.text}</span>
      {message.source && <span className="pet-bubble-source">{message.source}</span>}
      <div className="pet-bubble-arrow" />
    </div>
  );
}
