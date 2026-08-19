import { describe, expect, it } from 'vitest';

import { stepRace, tickToSeconds } from '../src/game/sim/race.js';
import {
  BALANCE,
  ENTRANT_COUNT,
  createRaceState,
  type CarState,
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
