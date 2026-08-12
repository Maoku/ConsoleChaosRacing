import { GENERATION_IDS, HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { createRaceState } from '../src/game/sim/state.js';
import { createDisplayLatch } from '../src/game/view/shared/display-state.js';
import {
  displayFrameForTick,
  quantizeTick,
  quantizeTime,
  quantizedFrame,
} from '../src/game/view/shared/quantize.js';

/**
 * 「見た目の更新レート」が世代ごとに効いていることを固定する
 * （実装計画 §3 冒頭 / §6.1 第1世代基準 5・第3世代基準 6）。
 *
 * レンダラーが `animationHz` を自動で適用するのは `SkinnedMeshCommand.animationTime` の
 * 量子化だけで、本作の車は skin を持たない。カクつきはゲーム側の責務なので、
 * ここが唯一の担保になる。
 */

/** 60Hz のティックのうち、実際に表示が変わる回数 */
const EXPECTED_UPDATES_PER_SECOND = { FC: 6, SFC: 12, PS1: 30, PS2: 60 } as const;

describe('見た目の更新レート', () => {
  it('プロファイルの animationHz が 6 / 12 / 30 / 60 になっている', () => {
    for (const generation of GENERATION_IDS) {
      expect(HARDWARE_GENERATION_PROFILES[generation].video.animationHz).toBe(
        EXPECTED_UPDATES_PER_SECOND[generation],
      );
    }
  });

  it('ラッチは 1 秒間にその世代のレートぶんしか更新しない', () => {
    for (const generation of GENERATION_IDS) {
      const profile = HARDWARE_GENERATION_PROFILES[generation];
      const state = createRaceState({ seed: 11, autoPilot: true });
      const latch = createDisplayLatch();

      let previous: unknown = null;
      let updates = 0;
      // ティック 0..59 のちょうど 1 秒ぶん。各ティックの状態を 1 回ずつ見る
      for (let tick = 0; tick < 60; tick++) {
        const snapshot = latch.sample(generation, profile, state);
        if (snapshot !== previous) updates += 1;
        previous = snapshot;
        stepRace(state);
      }
      expect(updates).toBe(EXPECTED_UPDATES_PER_SECOND[generation]);
    }
  });

  it('同じフレーム番号の間は中身が動かない', () => {
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const state = createRaceState({ seed: 11, autoPilot: true });
    const latch = createDisplayLatch();
    for (let tick = 0; tick < 240; tick++) stepRace(state);

    // FC は 10 ティックに 1 回。その間はまったく同じオブジェクトが返る
    const first = latch.sample('FC', profile, state);
    for (let tick = 0; tick < 9; tick++) {
      stepRace(state);
      const held = latch.sample('FC', profile, state);
      expect(held).toBe(first);
    }
    stepRace(state);
    const next = latch.sample('FC', profile, state);
    expect(next).not.toBe(first);
    expect(next.cars[0]!.s).not.toBe(first.cars[0]!.s);
  });

  it('世代ごとに別のラッチを持ち、切替演出中も互いに影響しない', () => {
    const state = createRaceState({ seed: 11, autoPilot: true });
    const latch = createDisplayLatch();
    for (let tick = 0; tick < 300; tick++) stepRace(state);

    // 切替中は 2 世代ぶんを同じフレームで積む。FC は止まり、PS2 は毎ティック動く
    const fcFirst = latch.sample('FC', HARDWARE_GENERATION_PROFILES.FC, state);
    const ps2First = latch.sample('PS2', HARDWARE_GENERATION_PROFILES.PS2, state);
    stepRace(state);
    expect(latch.sample('FC', HARDWARE_GENERATION_PROFILES.FC, state)).toBe(fcFirst);
    expect(latch.sample('PS2', HARDWARE_GENERATION_PROFILES.PS2, state)).not.toBe(ps2First);
  });

  it('quantizeTime / quantizedFrame / quantizeTick が整合している', () => {
    const fc = HARDWARE_GENERATION_PROFILES.FC;
    expect(quantizeTime(1.03, fc)).toBeCloseTo(1, 9);
    expect(quantizeTime(1.17, fc)).toBeCloseTo(7 / 6, 9);
    expect(quantizedFrame(1.03, fc)).toBe(6);
    // 60Hz のティック 0..9 は同じ FC フレームへ落ちる
    for (let tick = 0; tick < 10; tick++) expect(quantizeTick(tick, fc)).toBe(0);
    expect(quantizeTick(10, fc)).toBe(10);

    const ps2 = HARDWARE_GENERATION_PROFILES.PS2;
    expect(quantizeTick(37, ps2)).toBe(37);
    expect(quantizeTime(1.234, ps2)).toBeCloseTo(1.233333333, 6);

    // ティックからの計算は整数演算なので、60Hz では 1 ティック 1 フレームになる
    for (let tick = 0; tick < 600; tick++) {
      expect(displayFrameForTick(tick, ps2)).toBe(tick);
      expect(displayFrameForTick(tick, fc)).toBe(Math.floor(tick / 10));
    }
  });
});
