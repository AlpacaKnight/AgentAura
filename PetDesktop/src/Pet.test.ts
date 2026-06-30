import { describe, expect, it } from 'vitest';
import { DEFAULT_ANIMATIONS, STATE_ANIMATION } from './Pet';

describe('Codex pet animation contract', () => {
  it('maps the fixed 8x9 atlas rows', () => {
    expect(DEFAULT_ANIMATIONS.idle).toMatchObject({ row: 0, frames: 6 });
    expect(DEFAULT_ANIMATIONS['running-right']).toMatchObject({ row: 1, frames: 8 });
    expect(DEFAULT_ANIMATIONS['running-left']).toMatchObject({ row: 2, frames: 8 });
    expect(DEFAULT_ANIMATIONS.failed).toMatchObject({ row: 5, frames: 8 });
    expect(DEFAULT_ANIMATIONS.review).toMatchObject({ row: 8, frames: 6 });
  });

  it('maps every AgentAura state to an available animation', () => {
    for (const animation of Object.values(STATE_ANIMATION)) {
      expect(DEFAULT_ANIMATIONS[animation]).toBeDefined();
    }
  });
});
