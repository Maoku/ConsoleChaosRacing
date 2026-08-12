import { describe, expect, it } from 'vitest';

import { formatLapTime, stepRace } from '../src/game/sim/race.js';
import { ENTRANT_COUNT, LAP_COUNT, createRaceState, hashRaceState } from '../src/game/sim/state.js';
import { createScriptedInput } from './support/scripted-input.js';

const TICKS = 10_000;

function runScripted(seed: number, ticks: number): { hashes: number[]; final: number } {
  const state = createRaceState({ seed });
  const input = createScriptedInput(seed);
  const hashes: number[] = [];
  for (let tick = 0; tick < ticks; tick++) {
    stepRace(state, input(tick));
    if (tick % 500 === 0) hashes.push(hashRaceState(state));
  }
  return { hashes, final: hashRaceState(state) };
}

describe('シミュレーションの決定性', () => {
  it('同一シード・同一入力列で 10,000 ティック回すと状態ハッシュが一致する', () => {
    const first = runScripted(4417633, TICKS);
    const second = runScripted(4417633, TICKS);
    expect(second.hashes).toEqual(first.hashes);
    expect(second.final).toBe(first.final);
  });

  it('シードが変われば結果も変わる', () => {
    const first = runScripted(4417633, 2000);
    const other = runScripted(99991, 2000);
    expect(other.final).not.toBe(first.final);
  });

  it('AI だけで走らせても再現する', () => {
    const run = (): number => {
      const state = createRaceState({ seed: 20260812, autoPilot: true });
      for (let tick = 0; tick < 5000; tick++) stepRace(state);
      return hashRaceState(state);
    };
    expect(run()).toBe(run());
  });

  it('8 台が 3 周を完走し、順位とラップタイムが出る', () => {
    const state = createRaceState({ seed: 20260812, autoPilot: true });
    let ticks = 0;
    while (state.phase !== 'finished' && ticks < 60 * 60 * 20) {
      stepRace(state);
      ticks += 1;
    }

    expect(state.phase).toBe('finished');
    expect(state.cars).toHaveLength(ENTRANT_COUNT);

    for (const car of state.cars) {
      expect(car.finished).toBe(true);
      expect(car.lap).toBe(LAP_COUNT + 1);
      expect(car.lapTicks).toHaveLength(LAP_COUNT);
      expect(car.bestLapTicks).toBeGreaterThan(0);
      // ラップタイムが常識的な範囲に収まる（1 分〜3 分）
      expect(car.bestLapTicks).toBeGreaterThan(60 * 60);
      expect(car.bestLapTicks).toBeLessThan(60 * 180);
      expect(formatLapTime(car.bestLapTicks)).toMatch(/^\d:\d{2}\.\d{3}$/);
    }

    // 順位は 1..8 が重複なく割り当たり、ゴール順と一致する
    const standings = state.cars.map((car) => car.standing).sort((a, b) => a - b);
    expect(standings).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    const byFinish = [...state.cars].sort((a, b) => a.finishTick - b.finishTick);
    expect(byFinish.map((car) => car.standing)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  });

  it('走行中は順位が進行距離の降順になっている', () => {
    const state = createRaceState({ seed: 20260812, autoPilot: true });
    for (let tick = 0; tick < 4000; tick++) stepRace(state);
    const ordered = state.standingOrder.map((entrant) => state.cars[entrant]!);
    for (let index = 1; index < ordered.length; index++) {
      expect(ordered[index - 1]!.progress).toBeGreaterThanOrEqual(ordered[index]!.progress);
      expect(ordered[index]!.standing).toBe(index + 1);
    }
  });

  it('カウントダウン中は誰も動かない', () => {
    const state = createRaceState({ seed: 1, autoPilot: true });
    const before = state.cars.map((car) => car.s);
    for (let tick = 0; tick < 239; tick++) stepRace(state);
    expect(state.phase).toBe('countdown');
    expect(state.cars.map((car) => car.s)).toEqual(before);
    stepRace(state);
    expect(state.phase).toBe('racing');
  });
});
