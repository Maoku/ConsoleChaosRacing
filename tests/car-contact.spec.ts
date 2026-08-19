import { FIXED_DT_SECONDS } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { CONTACT, resolveCarContacts } from '../src/game/sim/collision.js';
import { stepRace } from '../src/game/sim/race.js';
import { createRaceState, type RaceState } from '../src/game/sim/state.js';
import { TRACK } from '../src/game/sim/track.js';
import { VEHICLE } from '../src/game/sim/vehicle.js';

/**
 * 車どうしの接触（実装計画 11-3 / R-3）。
 *
 * 改修前は 8 台が**同じ場所を占めたまま**走っていた。AI 8 台のデモ（240.7 秒）で
 * 車体（4.4 × 1.95 m の矩形）が重なっているティックが 739 / 14,442（5.1 %）あり、
 * レースの 5 % の時間、どこかの 2 台がすり抜けていた。
 *
 * ここで固定するのは「重なったまま 1 ティックを越えない」ことと、
 * 応答が**押し離しと速度の損だけ**（跳ね返さない・運動量が増えない）であること。
 */

const HALF_LENGTH = VEHICLE.CAR_LENGTH / 2;

/** その 2 台の車体矩形が重なっているか */
function overlaps(state: RaceState, left: number, right: number): boolean {
  const a = state.cars[left]!;
  const b = state.cars[right]!;
  if (a.finished || b.finished) return false;
  return (
    Math.abs(state.track.deltaS(a.s, b.s)) < VEHICLE.CAR_LENGTH &&
    Math.abs(a.lateral - b.lateral) < VEHICLE.CAR_WIDTH
  );
}

function overlappingPairs(state: RaceState): number {
  let count = 0;
  for (let left = 0; left < state.cars.length; left++) {
    for (let right = left + 1; right < state.cars.length; right++) {
      if (overlaps(state, left, right)) count += 1;
    }
  }
  return count;
}

/** 2 台だけを置いた最小のレース。残りは遠くへ退避させる */
function pair(options: {
  gapS: number;
  gapLateral: number;
  rearSpeed: number;
  frontSpeed: number;
}): RaceState {
  const state = createRaceState({ seed: 1 });
  state.phase = 'racing';
  state.countdown = 0;
  for (const [index, car] of state.cars.entries()) {
    car.s = TRACK.wrapS(index * 200);
    car.lateral = 0;
    car.speed = 0;
    car.yaw = 0;
  }
  const rear = state.cars[0]!;
  const front = state.cars[1]!;
  rear.s = 100;
  rear.lateral = 0;
  rear.speed = options.rearSpeed;
  front.s = TRACK.wrapS(100 + options.gapS);
  front.lateral = options.gapLateral;
  front.speed = options.frontSpeed;
  return state;
}

describe('車どうしの接触', () => {
  describe('デモ 1 本（AI 8 台・完走まで）', () => {
    const state = createRaceState({ seed: 20260812, autoPilot: true });
    let ticks = 0;
    let overlappingTicks = 0;
    let contactTicks = 0;
    while (state.phase !== 'finished' && state.tick < 60 * 400) {
      stepRace(state);
      ticks += 1;
      if (overlappingPairs(state) > 0) overlappingTicks += 1;
      if (state.cars.some((car) => car.hitKind === 'car')) contactTicks += 1;
    }

    it('完走まで走り切る（走査が空振りしていない）', () => {
      expect(state.phase).toBe('finished');
      expect(ticks).toBeGreaterThan(10_000);
    });

    it('接触そのものは起きている（判定が死んでいない）', () => {
      expect(contactTicks).toBeGreaterThan(0);
    });

    it('車体が重なったまま 1 ティックを越えない', () => {
      expect(overlappingTicks).toBe(0);
    });

    it('速度は常に非負のまま', () => {
      for (const car of state.cars) expect(car.speed).toBeGreaterThanOrEqual(0);
    });
  });

  describe('追突', () => {
    it('後ろの車の速度が落ち、合計の運動量は増えない', () => {
      const state = pair({ gapS: 3, gapLateral: 0, rearSpeed: 60, frontSpeed: 40 });
      const rear = state.cars[0]!;
      const front = state.cars[1]!;
      const before = rear.speed + front.speed;

      resolveCarContacts(state);

      expect(rear.speed).toBeLessThan(60);
      expect(front.speed).toBeGreaterThan(40);
      // 完全非弾性（0.5）に追加の損（0.35）が乗るので、合計は必ず減る
      expect(rear.speed + front.speed).toBeLessThan(before);
      // 追い越してしまわない（跳ね返さない）
      expect(rear.speed).toBeLessThan(front.speed + 1e-9);
    });

    it('前後に離れ、隙間が残る', () => {
      const state = pair({ gapS: 3, gapLateral: 0, rearSpeed: 60, frontSpeed: 40 });
      resolveCarContacts(state);
      const gap = Math.abs(state.track.deltaS(state.cars[1]!.s, state.cars[0]!.s));
      expect(gap).toBeCloseTo(VEHICLE.CAR_LENGTH + CONTACT.SEPARATION, 6);
      expect(overlappingPairs(state)).toBe(0);
    });

    it('近づいていないなら速度は落ちない（押し離すだけ）', () => {
      const state = pair({ gapS: 3, gapLateral: 0, rearSpeed: 40, frontSpeed: 60 });
      const rear = state.cars[0]!;
      const front = state.cars[1]!;
      resolveCarContacts(state);
      expect(rear.speed).toBe(40);
      expect(front.speed).toBe(60);
      expect(overlappingPairs(state)).toBe(0);
    });
  });

  describe('並走の擦り', () => {
    it('横へ離れ、速度の損は追突より小さい', () => {
      // 横の重なりのほうが浅い配置にする（前後はほぼ揃っている）
      const state = pair({ gapS: 0.4, gapLateral: 1.2, rearSpeed: 60, frontSpeed: 60 });
      const left = state.cars[0]!;
      const right = state.cars[1]!;
      left.yaw = 0.1;
      right.yaw = -0.1;

      resolveCarContacts(state);

      expect(Math.abs(right.lateral - left.lateral)).toBeCloseTo(
        VEHICLE.CAR_WIDTH + CONTACT.SEPARATION,
        6,
      );
      const sideLoss = 60 - left.speed;
      expect(sideLoss).toBeGreaterThan(0);

      const rearEnd = pair({ gapS: 3, gapLateral: 0, rearSpeed: 60, frontSpeed: 40 });
      const rearLoss = 60 - (resolveCarContacts(rearEnd), rearEnd.cars[0]!.speed);
      expect(sideLoss).toBeLessThan(rearLoss);
    });
  });

  describe('接触の記録', () => {
    it('hitKind = car と hitStrength > 0 が 1 ティックだけ立つ', () => {
      const state = pair({ gapS: 3, gapLateral: 0, rearSpeed: 60, frontSpeed: 40 });
      for (const car of state.cars) {
        car.hitKind = 'none';
        car.hitStrength = 0;
      }
      resolveCarContacts(state);
      expect(state.cars[0]!.hitKind).toBe('car');
      expect(state.cars[0]!.hitStrength).toBeGreaterThan(0);

      // 次のティックで `stepVehicle` が畳む
      stepRace(state);
      expect(state.cars[0]!.hitKind).not.toBe('car');
    });

    it('触れていない車には立たない', () => {
      const state = pair({ gapS: 40, gapLateral: 0, rearSpeed: 60, frontSpeed: 40 });
      resolveCarContacts(state);
      for (const car of state.cars) expect(car.hitKind).toBe('none');
    });
  });

  it('同一シードで 2 回走らせて完走ティックが完全一致する（決定性）', () => {
    const run = () => {
      const state = createRaceState({ seed: 20260812, autoPilot: true });
      while (state.phase !== 'finished' && state.tick < 60 * 400) stepRace(state);
      return state.cars.map((car) => car.finishTick);
    };
    expect(run()).toEqual(run());
  });

  it('車体の寸法はシムの 1 つの定義から来る（D-7）', () => {
    expect(VEHICLE.CAR_LENGTH).toBeGreaterThan(VEHICLE.CAR_WIDTH);
    // 1 ティックで進む距離より車体が十分長い。すり抜け（トンネリング）が起きない
    expect(VEHICLE.MAX_SPEED * FIXED_DT_SECONDS).toBeLessThan(HALF_LENGTH);
  });
});
