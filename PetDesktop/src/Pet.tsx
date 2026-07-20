import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize, PhysicalPosition } from '@tauri-apps/api/window';
import { api, isTauri, onPetScalePreview, onSnapshot } from './api';
import PetBubble from './PetBubble';
import type { AnimationSpec, AppSnapshot } from './types';

const DEFAULT_ANIMATIONS: Record<string, AnimationSpec> = {
  idle: { row: 0, frames: 6, durationsMs: [280, 110, 110, 140, 140, 320] },
  'running-right': { row: 1, frames: 8, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  'running-left': { row: 2, frames: 8, durationsMs: [120, 120, 120, 120, 120, 120, 120, 220] },
  waving: { row: 3, frames: 4, durationsMs: [140, 140, 140, 280] },
  jumping: { row: 4, frames: 5, durationsMs: [140, 140, 140, 140, 280] },
  failed: { row: 5, frames: 8, durationsMs: [140, 140, 140, 140, 140, 140, 140, 240] },
  waiting: { row: 6, frames: 6, durationsMs: [150, 150, 150, 150, 150, 260] },
  running: { row: 7, frames: 6, durationsMs: [120, 120, 120, 120, 120, 220] },
  review: { row: 8, frames: 6, durationsMs: [150, 150, 150, 150, 150, 280] },
  'look-directions-a': { row: 9, frames: 8, durationsMs: [200, 200, 200, 200, 200, 200, 200, 300] },
  'look-directions-b': { row: 10, frames: 8, durationsMs: [180, 180, 180, 180, 180, 180, 180, 260] },
};

const STATE_ANIMATION: Record<string, string> = {
  init: 'waving',
  running: 'running',
  busy: 'review',
  waiting: 'waiting',
  idle: 'idle',
  error: 'failed',
  offline: 'idle',
  upgrade: 'jumping',
};

type LookFrame = { animationName: 'look-directions-a' | 'look-directions-b'; frame: number };

function resolveLookDirection(direction: number | undefined, spriteVersion: number): LookFrame | undefined {
  if (
    spriteVersion < 2 ||
    direction === undefined ||
    !Number.isInteger(direction) ||
    direction < 0 ||
    direction > 15
  ) return undefined;
  return direction < 8
    ? { animationName: 'look-directions-a', frame: direction }
    : { animationName: 'look-directions-b', frame: direction - 8 };
}

function resolveActiveLookDirection(
  direction: number | undefined,
  spriteVersion: number,
  state: string,
  moving: boolean,
): LookFrame | undefined {
  if (state !== 'idle' || moving) return undefined;
  return resolveLookDirection(direction, spriteVersion);
}

export default function Pet() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [asset, setAsset] = useState('');
  const [frame, setFrame] = useState(0);
  const [lookDirection, setLookDirection] = useState<number>();
  const [moving, setMoving] = useState<'running-left' | 'running-right'>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewScale, setPreviewScale] = useState<number>();
  const [bubbleHeight, setBubbleHeight] = useState(0);
  const roamTimer = useRef<number | undefined>(undefined);

  const refresh = useCallback(async () => {
    const next = await api.snapshot();
    setSnapshot(next);
    setAsset(await api.selectedPetAsset());
  }, []);

  useEffect(() => {
    void refresh();
    let stop: (() => void) | undefined;
    void onSnapshot(next => {
      setSnapshot(next);
      void api.selectedPetAsset().then(setAsset);
    }).then(unlisten => { stop = unlisten; });
    return () => stop?.();
  }, [refresh]);

  useEffect(() => {
    let stop: (() => void) | undefined;
    void onPetScalePreview(setPreviewScale).then(unlisten => { stop = unlisten; });
    return () => stop?.();
  }, []);

  const lookFrame = resolveActiveLookDirection(
    lookDirection,
    snapshot?.selectedPet?.spriteVersion ?? 1,
    snapshot?.effectiveState ?? 'idle',
    moving !== undefined,
  );
  const animationName = moving ?? lookFrame?.animationName ?? STATE_ANIMATION[snapshot?.effectiveState ?? 'idle'];
  // 回退时校验目标行不超出当前宠物的实际行数，避免 V1 宠物渲染越界（空白帧）。
  const petRows = snapshot?.selectedPet?.rows ?? 9;
  const fallbackAnimation = DEFAULT_ANIMATIONS[animationName];
  const animation =
    snapshot?.selectedPet?.animations[animationName] ??
    (fallbackAnimation && fallbackAnimation.row < petRows ? fallbackAnimation : undefined) ??
    DEFAULT_ANIMATIONS.idle;
  const scale = previewScale ?? snapshot?.settings.petScale ?? 1;

  useEffect(() => {
    setFrame(0);
  }, [animationName]);

  useEffect(() => {
    if (lookFrame) return;
    const duration = animation.durationsMs[frame] ?? animation.durationsMs.at(-1) ?? 150;
    const timer = window.setTimeout(() => setFrame(value => (value + 1) % animation.frames), duration);
    return () => window.clearTimeout(timer);
  }, [animation, frame, lookFrame]);

  useEffect(() => {
    const canLook =
      (snapshot?.selectedPet?.spriteVersion ?? 1) >= 2 &&
      snapshot?.effectiveState === 'idle' &&
      !moving;
    if (!canLook) {
      setLookDirection(undefined);
      return;
    }
    const delay = lookDirection === undefined
      ? 4000 + Math.random() * 4000
      : 700 + Math.random() * 500;
    const timer = window.setTimeout(() => {
      setLookDirection(current => current === undefined ? Math.floor(Math.random() * 16) : undefined);
    }, delay);
    return () => window.clearTimeout(timer);
  }, [snapshot?.selectedPet?.spriteVersion, snapshot?.effectiveState, moving, lookDirection]);

  const bubbleEnabled = snapshot?.settings.petBubble.enabled ?? false;
  // 气泡可见但高度尚未测量到时，用 60px 估计值确保窗口足够高，避免被 overflow:hidden 裁切。
  const effectiveBubbleHeight = bubbleEnabled ? (bubbleHeight > 0 ? bubbleHeight : 60) : 0;

  useEffect(() => {
    if (!isTauri() || !snapshot) return;
    const windowHandle = getCurrentWindow();
    let cancelled = false;
    void windowHandle.setAlwaysOnTop(snapshot.settings.alwaysOnTop);
    void windowHandle.setIgnoreCursorEvents(snapshot.settings.clickThrough);

    // 气泡的 CSS 尺寸不随 petScale 缩小（只有 sprite 缩放），所以气泡高度
    // 按实际 CSS 像素参与窗口计算，不乘 scale；宠物区域才乘 scale。
    const bubbleVisible = bubbleEnabled && effectiveBubbleHeight > 0;
    const width = (bubbleVisible ? 320 : 220) * scale;
    const height = 240 * scale + (bubbleVisible ? effectiveBubbleHeight : 0);
    void (async () => {
      // 气泡高度变化时上移窗口保持脚底屏幕坐标不变。
      if (bubbleEnabled && effectiveBubbleHeight > 0) {
        const monitor = await currentMonitor();
        const factor = monitor?.scaleFactor || 1;
        const prev = await windowHandle.outerSize();
        if (cancelled) return;
        const prevH = prev.height / factor;
        const deltaLogical = height - prevH;
        if (Math.abs(deltaLogical) > 0.5) {
          const pos = await windowHandle.outerPosition();
          if (cancelled) return;
          const newY = pos.y - Math.round(deltaLogical * factor);
          await windowHandle.setPosition(new PhysicalPosition(pos.x, newY));
        }
      }
      if (cancelled) return;
      await windowHandle.setSize(new LogicalSize(width, height));
      if (cancelled) return;
      // 窗口尺寸调整后执行显示器夹取，确保不被裁切。
      await clampToMonitor(windowHandle, () => cancelled);
    })();

    snapshot.settings.petVisible ? void windowHandle.show() : void windowHandle.hide();
    return () => { cancelled = true; };
  }, [snapshot?.settings.alwaysOnTop, snapshot?.settings.clickThrough, snapshot?.settings.petVisible, bubbleEnabled, effectiveBubbleHeight, scale]);

  const handleBubbleHeight = useCallback((height: number) => setBubbleHeight(height), []);

  useEffect(() => {
    if (!snapshot?.settings.roamEnabled || snapshot.effectiveState === 'busy' || snapshot.effectiveState === 'waiting' || snapshot.effectiveState === 'error' || !isTauri()) {
      if (roamTimer.current) window.clearInterval(roamTimer.current);
      return;
    }
    const roam = async () => {
      const win = getCurrentWindow();
      const position = await win.outerPosition();
      const monitor = await currentMonitor();
      if (!monitor) return;
      const factor = monitor.scaleFactor || 1;
      // 气泡可见时窗口宽度为 320，否则 220，需与窗口尺寸 effect 一致。
      const winWidth = (snapshot.settings.petBubble.enabled && effectiveBubbleHeight > 0 ? 320 : 220) * scale * factor;
      const minX = monitor.position.x;
      const maxX = monitor.position.x + monitor.size.width - winWidth;
      const distance = Math.min(220 * factor, Math.max(80 * factor, (maxX - minX) * 0.15));
      const direction = Math.random() > 0.5 ? 1 : -1;
      const destination = Math.max(minX, Math.min(maxX, position.x + distance * direction));
      setMoving(direction > 0 ? 'running-right' : 'running-left');
      const started = performance.now();
      const startX = position.x;
      const duration = Math.max(500, Math.abs(destination - startX) / snapshot.settings.roamSpeed * 1000);
      const tick = async (now: number) => {
        const progress = Math.min(1, (now - started) / duration);
        const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
        await win.setPosition(new LogicalPosition((startX + (destination - startX) * eased) / factor, position.y / factor));
        if (progress < 1) requestAnimationFrame(tick);
        else setMoving(undefined);
      };
      requestAnimationFrame(tick);
    };
    roamTimer.current = window.setInterval(() => void roam(), snapshot.settings.roamIntervalSeconds * 1000);
    return () => window.clearInterval(roamTimer.current);
  }, [snapshot?.settings.roamEnabled, snapshot?.settings.roamIntervalSeconds, snapshot?.settings.roamSpeed, snapshot?.effectiveState, scale, bubbleEnabled, effectiveBubbleHeight]);

  const spriteStyle = useMemo(() => {
    const pet = snapshot?.selectedPet;
    if (!pet || !asset) return undefined;
    return {
      width: pet.frameWidth,
      height: pet.frameHeight,
      backgroundImage: `url(${asset})`,
      backgroundPosition: `${-(lookFrame?.frame ?? frame) * pet.frameWidth}px ${-animation.row * pet.frameHeight}px`,
      transform: `scale(${scale})`,
      transformOrigin: 'bottom center',
    };
  }, [snapshot?.selectedPet, asset, animation.row, frame, lookFrame?.frame, scale]);

  const drag = (event: React.MouseEvent) => {
    if (menuOpen) return;
    if (event.button === 0 && isTauri()) void getCurrentWindow().startDragging();
  };

  // Pet 窗口动态尺寸后的显示器夹取，与 Rust 端 clamp_to_monitor 逻辑一致。
  const clampToMonitor = async (win: ReturnType<typeof getCurrentWindow>, cancelled?: () => boolean) => {
    const monitor = await currentMonitor();
    if (!monitor || cancelled?.()) return;
    const position = await win.outerPosition();
    if (cancelled?.()) return;
    const size = await win.outerSize();
    if (cancelled?.()) return;
    const origin = monitor.position;
    const bounds = monitor.size;
    const maxX = Math.max(origin.x + bounds.width - size.width, origin.x);
    const maxY = Math.max(origin.y + bounds.height - size.height, origin.y);
    const x = Math.min(Math.max(position.x, origin.x), maxX);
    const y = Math.min(Math.max(position.y, origin.y), maxY);
    if (x !== position.x || y !== position.y) {
      await win.setPosition(new PhysicalPosition(x, y));
    }
  };

  const contextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    setMenuOpen(value => !value);
  };

  const toggleRoam = async () => {
    if (!snapshot) return;
    await api.saveSettings({
      ...snapshot.settings,
      roamEnabled: !snapshot.settings.roamEnabled,
    });
    setMenuOpen(false);
  };

  if (!snapshot) return null;

  return (
    <div className={`pet-window state-${snapshot.effectiveState}`} style={{ '--pet-scale': scale } as React.CSSProperties} onMouseDown={drag} onContextMenu={contextMenu} onDoubleClick={() => void api.showManagement()}>
      <PetBubble snapshot={snapshot} settings={snapshot.settings.petBubble} menuOpen={menuOpen} onHeightChange={handleBubbleHeight} />
      {asset ? <div className="sprite" style={spriteStyle} /> : <div className="fallback-pet">✦<span>{snapshot.effectiveState}</span></div>}
      <div className="pet-state-badge">{snapshot.effectiveState}</div>
      {menuOpen && <div className="pet-context-menu" onMouseDown={event => event.stopPropagation()}>
        <button onClick={() => { setMenuOpen(false); void api.showManagement(); }}>打开管理页</button>
        <button onClick={() => void toggleRoam()}>{snapshot.settings.roamEnabled ? '停止闲逛' : '开始闲逛'}</button>
        <button onClick={() => { setMenuOpen(false); void api.showPet(false); }}>隐藏桌宠</button>
      </div>}
    </div>
  );
}

export { DEFAULT_ANIMATIONS, STATE_ANIMATION, resolveLookDirection, resolveActiveLookDirection };
