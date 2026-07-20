import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ANIMATIONS,
  STATE_ANIMATION,
  resolveActiveLookDirection,
  resolveLookDirection,
} from './Pet';

describe('Codex pet animation contract', () => {
  it('maps the fixed 8x9 atlas rows', () => {
    expect(DEFAULT_ANIMATIONS.idle).toMatchObject({ row: 0, frames: 6 });
    expect(DEFAULT_ANIMATIONS['running-right']).toMatchObject({ row: 1, frames: 8 });
    expect(DEFAULT_ANIMATIONS['running-left']).toMatchObject({ row: 2, frames: 8 });
    expect(DEFAULT_ANIMATIONS.failed).toMatchObject({ row: 5, frames: 8 });
    expect(DEFAULT_ANIMATIONS.review).toMatchObject({ row: 8, frames: 6 });
    expect(DEFAULT_ANIMATIONS['look-directions-a']).toMatchObject({ row: 9, frames: 8 });
    expect(DEFAULT_ANIMATIONS['look-directions-b']).toMatchObject({ row: 10, frames: 8 });
  });

  it('maps every AgentAura state to an available animation', () => {
    for (const animation of Object.values(STATE_ANIMATION)) {
      expect(DEFAULT_ANIMATIONS[animation]).toBeDefined();
    }
  });

  it('maps busy to the review animation used by the hardware firmware', () => {
    expect(STATE_ANIMATION.busy).toBe('review');
  });

  it('does not map offline to v2 look-direction rows', () => {
    expect(STATE_ANIMATION.offline).toBe('idle');
    expect(Object.values(STATE_ANIMATION)).not.toContain('look-directions-a');
    expect(Object.values(STATE_ANIMATION)).not.toContain('look-directions-b');
  });

  it('maps all 16 v2 look directions to two fixed-frame rows', () => {
    expect(resolveLookDirection(0, 2)).toEqual({ animationName: 'look-directions-a', frame: 0 });
    expect(resolveLookDirection(7, 2)).toEqual({ animationName: 'look-directions-a', frame: 7 });
    expect(resolveLookDirection(8, 2)).toEqual({ animationName: 'look-directions-b', frame: 0 });
    expect(resolveLookDirection(15, 2)).toEqual({ animationName: 'look-directions-b', frame: 7 });
  });

  it('keeps v1 pets and invalid directions on their state animation', () => {
    expect(resolveLookDirection(0, 1)).toBeUndefined();
    expect(resolveLookDirection(-1, 2)).toBeUndefined();
    expect(resolveLookDirection(1.5, 2)).toBeUndefined();
    expect(resolveLookDirection(16, 2)).toBeUndefined();
  });

  it('drops a pending look frame immediately when state or movement changes', () => {
    expect(resolveActiveLookDirection(3, 2, 'idle', false)).toEqual({
      animationName: 'look-directions-a',
      frame: 3,
    });
    expect(resolveActiveLookDirection(3, 2, 'busy', false)).toBeUndefined();
    expect(resolveActiveLookDirection(3, 2, 'idle', true)).toBeUndefined();
  });
});
