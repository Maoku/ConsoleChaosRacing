import { describe, expect, it } from 'vitest';

import { stepRace, tickToSeconds } from '../src/game/sim/race.js';
import {
  BALANCE,
  DIFFICULTY,
  ENTRANT_COUNT,
  LAP_COUNT,
  NO_TARGET,
  createRaceState,
  targetRaceTicksFor,
  type CarState,
  type Difficulty,
  type RaceState,
} from '../src/game/sim/state.js';

/**
 * ゲームバランス（バランス改修計画 §7.1）。
 *
 * ここが固定するのは**要求そのもの**であって定数の値ではない。とくに R-1 は
 * 「`SPEED_SCALE` が 0.95」ではなく「**走行中に実際に出る最高速度の比が 0.95**」を主語にする
 * （コースの直線が短く、最高速度の定数はこのコースでは終速の上限として効かないため）。
 */

/** 干渉のない単独走行にするため、1 台だけ残したレース状態を作る */
function soloRace(configure: (car: CarState) => void): { state: RaceState; car: CarState } {
  const state = createRaceState({ seed: 20260812, autoPilot: true });
  // 自機（個体差なし・理想ライン・ペース 1.0）を基準の走りとして使う
  const car = state.cars[0]!;
  configure(car);
  const cars = state.cars as CarState[];
  cars.length = 0;
  cars.push(car);
  const order = state.standingOrder as number[];
  order.length = 0;
  order.push(0);
  car.s = state.track.wrapS(0);
  car.lateral = 0;
  return { state, car };
}

interface SoloResult {
  /** 2 周目に出た最高速度 [m/s] */
  readonly maxSpeed: number;
  /** 2 周目のラップタイム [s] */
  readonly lapSeconds: number;
}

/** 2 周走らせ、立ち上がりの影響が消えた 2 周目を測る */
function soloRun(configure: (car: CarState) => void): SoloResult {
  const { state, car } = soloRace(configure);
  let maxSpeed = 0;
  let lapStartTick = -1;
  for (let tick = 0; tick < 60 * 600; tick++) {
    stepRace(state);
    if (car.lap === 2) {
      if (lapStartTick < 0) lapStartTick = state.tick;
      if (car.speed > maxSpeed) maxSpeed = car.speed;
    }
    if (car.lap === 3) return { maxSpeed, lapSeconds: tickToSeconds(state.tick - lapStartTick) };
  }
  throw new Error('2 周を走りきれなかった');
}

describe('バランス: 敵車の最高速度（R-1）', () => {
  it('敵車が走行中に出す最高速度は自機の 0.95 倍', () => {
    // 速度スケール以外は同じ条件（同じライン・同じペース）で比べる
    const player = soloRun((car) => {
      (car as { speedScale: number }).speedScale = 1;
    });
    const rival = soloRun((car) => {
      (car as { speedScale: number }).speedScale = BALANCE.SPEED_SCALE;
    });

    expect(rival.maxSpeed / player.maxSpeed).toBeCloseTo(0.95, 2);
    expect(Math.abs(rival.maxSpeed / player.maxSpeed - 0.95)).toBeLessThanOrEqual(0.005);
    // 加速も同じ倍率なので、コーナー立ち上がりの損もあわせてラップに出る
    expect(rival.lapSeconds).toBeGreaterThan(player.lapSeconds);
  });

  it('敵車 7 台の速度スケールは等しく、自機だけが 1', () => {
    const state = createRaceState({ seed: 20260812 });
    expect(state.cars).toHaveLength(ENTRANT_COUNT);
    expect(state.cars[0]!.speedScale).toBe(1);
    for (let entrant = 1; entrant < ENTRANT_COUNT; entrant++) {
      expect(state.cars[entrant]!.speedScale).toBe(BALANCE.SPEED_SCALE);
    }
  });
});

/** 敵車のエントラント番号 1..7 */
const RIVALS = Array.from({ length: ENTRANT_COUNT - 1 }, (_, index) => index + 1);
const DIFFICULTIES: Difficulty[] = ['easy', 'normal', 'hard'];

/** ばらつきを除いた素の目標レースタイム [s] */
function baseTargetSeconds(entrant: number, difficulty: Difficulty): number {
  return tickToSeconds(targetRaceTicksFor(entrant, difficulty, 0));
}

describe('バランス: 目標タイム（R-2 a/b/c）', () => {
  it('トップと最下位の目標レースタイムの差が 15 秒', () => {
    for (const difficulty of DIFFICULTIES) {
      const leader = baseTargetSeconds(1, difficulty);
      const last = baseTargetSeconds(ENTRANT_COUNT - 1, difficulty);
      expect(last - leader).toBeCloseTo(DIFFICULTY[difficulty].fieldSpreadSeconds, 2);
    }
  });

  it('目標はグリッド順に単調増加する（前ほど速い）', () => {
    for (const difficulty of DIFFICULTIES) {
      for (let entrant = 2; entrant < ENTRANT_COUNT; entrant++) {
        expect(baseTargetSeconds(entrant, difficulty)).toBeGreaterThan(
          baseTargetSeconds(entrant - 1, difficulty),
        );
      }
    }
  });

  it('スタート時のばらつきは 0〜+2 秒で、シードが同じなら毎回同じ', () => {
    for (const seed of [1, 7, 20260812, 99991, 4417633]) {
      const first = createRaceState({ seed });
      const second = createRaceState({ seed });
      for (const entrant of RIVALS) {
        const jitter =
          tickToSeconds(first.cars[entrant]!.targetRaceTicks) - baseTargetSeconds(entrant, 'normal');
        expect(jitter).toBeGreaterThanOrEqual(-1 / 60);
        expect(jitter).toBeLessThanOrEqual(BALANCE.START_JITTER_SECONDS + 1 / 60);
        expect(second.cars[entrant]!.targetRaceTicks).toBe(first.cars[entrant]!.targetRaceTicks);
      }
    }
  });

  it('自機は目標タイムを持たない', () => {
    expect(createRaceState({ seed: 20260812 }).cars[0]!.targetRaceTicks).toBe(NO_TARGET);
  });

  it('難易度を上げると全車の目標が短くなり、hard でも AI の限界を下回らない', () => {
    for (const entrant of RIVALS) {
      expect(baseTargetSeconds(entrant, 'normal')).toBeLessThan(baseTargetSeconds(entrant, 'easy'));
      expect(baseTargetSeconds(entrant, 'hard')).toBeLessThan(baseTargetSeconds(entrant, 'normal'));
    }
    // 敵車スペックの AI の限界（単独・ペース 1.0・ポールから完走）
    const limit = LAP_COUNT * 71.483 + BALANCE.STANDING_START_SECONDS;
    expect(baseTargetSeconds(1, 'hard')).toBeGreaterThan(limit);
  });
});
