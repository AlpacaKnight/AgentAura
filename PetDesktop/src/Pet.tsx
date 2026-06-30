import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { currentMonitor, getCurrentWindow, LogicalPosition, LogicalSize } from '@tauri-apps/api/window';
import { api, isTauri, onPetScalePreview, onSnapshot } from './api';
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
};

const STATE_ANIMATION: Record<string, string> = {
  init: 'waving',
  running: 'running',
  busy: 'running',
  waiting: 'waiting',
  idle: 'idle',
  error: 'failed',
  offline: 'idle',
  upgrade: 'jumping',
};

export default function Pet() {
  const [snapshot, setSnapshot] = useState<AppSnapshot>();
  const [asset, setAsset] = useState('');
  const [frame, setFrame] = useState(0);
  const [moving, setMoving] = useState<'running-left' | 'running-right'>();
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewScale, setPreviewScale] = useState<number>();
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

  const animationName = moving ?? STATE_ANIMATION[snapshot?.effectiveState ?? 'idle'];
  const animation = snapshot?.selectedPet?.animations[animationName] ?? DEFAULT_ANIMATIONS[animationName] ?? DEFAULT_ANIMATIONS.idle;
  const scale = previewScale ?? snapshot?.settings.petScale ?? 1;

  useEffect(() => {
    setFrame(0);
  }, [animationName]);

  useEffect(() => {
    const duration = animation.durationsMs[frame] ?? animation.durationsMs.at(-1) ?? 150;
    const timer = window.setTimeout(() => setFrame(value => (value + 1) % animation.frames), duration);
    return () => window.clearTimeout(timer);
  }, [animation, frame]);

  useEffect(() => {
    if (!isTauri() || !snapshot) return;
    const windowHandle = getCurrentWindow();
    void windowHandle.setAlwaysOnTop(snapshot.settings.alwaysOnTop);
    void windowHandle.setIgnoreCursorEvents(snapshot.settings.clickThrough);
    void windowHandle.setSize(new LogicalSize(220 * scale, 240 * scale));
    snapshot.settings.petVisible ? void windowHandle.show() : void windowHandle.hide();
  }, [snapshot?.settings.alwaysOnTop, snapshot?.settings.clickThrough, snapshot?.settings.petVisible, scale]);

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
      const width = 220 * scale * factor;
      const minX = monitor.position.x;
      const maxX = monitor.position.x + monitor.size.width - width;
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
  }, [snapshot?.settings.roamEnabled, snapshot?.settings.roamIntervalSeconds, snapshot?.settings.roamSpeed, snapshot?.effectiveState, scale]);

  const spriteStyle = useMemo(() => {
    const pet = snapshot?.selectedPet;
    if (!pet || !asset) return undefined;
    return {
      width: pet.frameWidth,
      height: pet.frameHeight,
      backgroundImage: `url(${asset})`,
      backgroundPosition: `${-frame * pet.frameWidth}px ${-animation.row * pet.frameHeight}px`,
      transform: `scale(${scale})`,
      transformOrigin: 'bottom center',
    };
  }, [snapshot?.selectedPet, asset, animation.row, frame, scale]);

  const drag = (event: React.MouseEvent) => {
    if (menuOpen) return;
    if (event.button === 0 && isTauri()) void getCurrentWindow().startDragging();
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
    <div className={`pet-window state-${snapshot.effectiveState}`} onMouseDown={drag} onContextMenu={contextMenu} onDoubleClick={() => void api.showManagement()}>
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

export { DEFAULT_ANIMATIONS, STATE_ANIMATION };
