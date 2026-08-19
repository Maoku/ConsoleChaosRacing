import { describe, expect, it } from 'vitest';

import { PACE } from '../src/game/sim/ai.js';
import { stepRace, tickToSeconds } from '../src/game/sim/race.js';
import {
  BALANCE,
  COUNTDOWN_TICKS,
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

interface RaceResult {
  /** 敵車の完走タイム [s]。GO から */
  readonly actualSeconds: number[];
  /** 敵車の目標タイム [s] */
  readonly targetSeconds: number[];
  /** 敵車の順位 */
  readonly standings: number[];
  /** 走行中に観測したペースの最小・最大 */
  readonly paceRange: [number, number];
  /** ペースの変化率の最大 [1/s]。GO の初期化は含めない */
  readonly maxPaceRate: number;
  readonly finishTicks: number[];
  /** 車どうしが接触したティック数（11-8）。目標の達成度に効くので一緒に測る */
  readonly contactTicks: number;
}

/** 完走まで回して、目標に対する結果を集める */
function runRace(seed: number, difficulty: Difficulty): RaceResult {
  const state = createRaceState({ seed, autoPilot: true, difficulty });
  const previousPace = state.cars.map((car) => car.pace);
  let paceMin = Number.POSITIVE_INFINITY;
  let paceMax = Number.NEGATIVE_INFINITY;
  let maxPaceRate = 0;
  let contactTicks = 0;

  while (state.phase !== 'finished' && state.tick < 60 * 60 * 20) {
    stepRace(state);
    if (state.cars.some((car) => car.hitKind === 'car')) contactTicks += 1;
    for (const car of state.cars) {
      if (car.targetRaceTicks === NO_TARGET || car.finished) continue;
      paceMin = Math.min(paceMin, car.pace);
      paceMax = Math.max(paceMax, car.pace);
      // GO の 1 ティックは「初期値を置く」ので変化率には数えない（§4.4）
      if (state.tick > COUNTDOWN_TICKS + 1) {
        maxPaceRate = Math.max(maxPaceRate, Math.abs(car.pace - previousPace[car.entrant]!) * 60);
      }
      previousPace[car.entrant] = car.pace;
    }
  }
  expect(state.phase).toBe('finished');

  const rivals = state.cars.slice(1);
  return {
    actualSeconds: rivals.map((car) => tickToSeconds(car.finishTick - COUNTDOWN_TICKS)),
    targetSeconds: rivals.map((car) => tickToSeconds(car.targetRaceTicks)),
    standings: rivals.map((car) => car.standing),
    paceRange: [paceMin, paceMax],
    maxPaceRate,
    finishTicks: state.cars.map((car) => car.finishTick),
    contactTicks,
  };
}

/** スピアマンの順位相関 */
function rankCorrelation(left: number[], right: number[]): number {
  const rankOf = (values: number[]): number[] => {
    const order = values.map((value, index) => ({ value, index })).sort((a, b) => a.value - b.value);
    const ranks = new Array<number>(values.length);
    order.forEach((entry, rank) => (ranks[entry.index] = rank));
    return ranks;
  };
  const a = rankOf(left);
  const b = rankOf(right);
  const count = a.length;
  const squared = a.reduce((sum, rank, index) => sum + (rank - b[index]!) ** 2, 0);
  return 1 - (6 * squared) / (count * (count * count - 1));
}

// 完走まで回すテストは 1 レースあたり 1 秒強かかる。既定の 5 秒では足りない
const RACE_TIMEOUT_MS = 120_000;

describe('バランス: 目標タイムの達成（R-2 d）', () => {
  const seeds = [20260812, 7, 99991];
  const results = new Map<string, RaceResult>();
  const resultFor = (seed: number, difficulty: Difficulty): RaceResult => {
    const key = `${seed}:${difficulty}`;
    const cached = results.get(key);
    if (cached) return cached;
    const fresh = runRace(seed, difficulty);
    results.set(key, fresh);
    return fresh;
  };

  it('各敵車の完走タイムが目標の −0.5 〜 +2.0 秒に収まる', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of seeds) {
        const result = resultFor(seed, difficulty);
        for (let index = 0; index < result.actualSeconds.length; index++) {
          const error = result.actualSeconds[index]! - result.targetSeconds[index]!;
          expect(error, `${difficulty}/${seed}/entrant ${index + 1}`).toBeGreaterThanOrEqual(-0.5);
          expect(error, `${difficulty}/${seed}/entrant ${index + 1}`).toBeLessThanOrEqual(2.0);
        }
      }
    }
  }, RACE_TIMEOUT_MS);

  /**
   * 車どうしの衝突（11-3）は目標タイムの達成度に効く。**接触は実際に起きていて、
   * それでも目標に収まっている**ことをここで固定する（11-8・§7 リスク 1）。
   *
   * 接触が 0 になったら、上の許容範囲は「衝突が無い世界」の値でしかない。
   */
  it('車どうしの接触が起きたうえで目標に収まっている（11-8）', () => {
    let total = 0;
    for (const difficulty of DIFFICULTIES) {
      for (const seed of seeds) total += resultFor(seed, difficulty).contactTicks;
    }
    expect(total, 'デモのレースで接触が 1 度も起きていない').toBeGreaterThan(0);
  }, RACE_TIMEOUT_MS);

  it('実測のトップと最下位の差が 15 ± 3 秒', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of seeds) {
        const times = resultFor(seed, difficulty).actualSeconds;
        const spread = Math.max(...times) - Math.min(...times);
        expect(spread, `${difficulty}/${seed}`).toBeGreaterThanOrEqual(12);
        expect(spread, `${difficulty}/${seed}`).toBeLessThanOrEqual(18);
      }
    }
  }, RACE_TIMEOUT_MS);

  it('順位が目標タイム順とおおむね一致する', () => {
    for (const seed of seeds) {
      const result = resultFor(seed, 'normal');
      expect(rankCorrelation(result.targetSeconds, result.standings)).toBeGreaterThanOrEqual(0.8);
    }
  }, RACE_TIMEOUT_MS);

  it('ペースは常に上下限の内側にある', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of seeds) {
        const [minimum, maximum] = resultFor(seed, difficulty).paceRange;
        expect(minimum).toBeGreaterThanOrEqual(PACE.MIN);
        expect(maximum).toBeLessThanOrEqual(PACE.MAX);
      }
    }
  }, RACE_TIMEOUT_MS);

  it('ペースの変化率が 1 秒あたり 0.1 を超えない（不自然な加減速の禁止）', () => {
    for (const difficulty of DIFFICULTIES) {
      for (const seed of seeds) {
        expect(resultFor(seed, difficulty).maxPaceRate, `${difficulty}/${seed}`).toBeLessThanOrEqual(0.1);
      }
    }
  }, RACE_TIMEOUT_MS);

  it('実操作の自機はペース制御を受けない', () => {
    const state = createRaceState({ seed: 20260812 });
    const player = state.cars[0]!;
    expect(player.targetRaceTicks).toBe(NO_TARGET);
    for (let tick = 0; tick < 3000; tick++) {
      stepRace(state, { steer: 0, throttle: 1, brake: 0 });
      expect(player.pace).toBe(1);
    }
  });

  it('同一シード・同一難易度なら完走ティックまで一致する（決定性）', () => {
    const first = runRace(4417633, 'normal');
    const second = runRace(4417633, 'normal');
    expect(second.finishTicks).toEqual(first.finishTicks);
  }, RACE_TIMEOUT_MS);
});

describe('バランス: アトラクトデモの自機（§4.5）', () => {
  it('デモの自機は中位の目標を持ち、ポールから順位を下げて中盤で競る', () => {
    const state = createRaceState({ seed: 20260812, autoPilot: true });
    const player = state.cars[0]!;
    // 目標は entrant 4 相当（ばらつきは無し）。自機のスペック（速度スケール 1）は変えない
    expect(player.speedScale).toBe(1);
    expect(player.targetRaceTicks).toBe(targetRaceTicksFor(4, 'normal', 0));

    const standings: number[] = [];
    while (state.phase !== 'finished' && state.tick < 60 * 60 * 20) {
      stepRace(state);
      if (!player.finished) standings.push(player.standing);
    }
    // ポール（1 位）から始まり、最後は中位へ落ちている ＝ 独走にならない
    expect(standings[0]).toBe(1);
    expect(player.standing).toBeGreaterThan(2);
    expect(player.standing).toBeLessThan(7);
    const error =
      tickToSeconds(player.finishTick - COUNTDOWN_TICKS) - tickToSeconds(player.targetRaceTicks);
    expect(Math.abs(error)).toBeLessThan(1);
  }, RACE_TIMEOUT_MS);
});
