import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { createGenerationController, type GenerationId } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { createRaceState, hashRaceState } from '../src/game/sim/state.js';
import { createScriptedInput } from './support/scripted-input.js';

/**
 * 「シミュレーションは 1 つ。世代は表示と入出力の作法だけを変える」を機械的に固定する。
 */

const SWITCHES: ReadonlyArray<readonly [tick: number, generation: GenerationId]> = [
  [500, 'PS2'],
  [900, 'SFC'],
  [1300, 'PS1'],
  [1700, 'FC'],
];

const TICKS = 2200;
/** 切替演出は最長 600 ms ＝ 36 ティック。その間も両世代ぶんのビューが積まれる */
const TRANSITION_TICKS = 36;

function run(withSwitches: boolean): number[] {
  const state = createRaceState({ seed: 20260812, autoPilot: true });
  const generation = createGenerationController('FC');
  const input = createScriptedInput(20260812);
  const hashes: number[] = [];

  for (let tick = 0; tick < TICKS; tick++) {
    if (withSwitches) {
      for (const [at, target] of SWITCHES) {
        if (tick === at) generation.request(target);
      }
      generation.advance(1000 / 60);
      // 切替中はレンダラーが 2 世代ぶん描く。ビューはそれに追随するが、シムは無関係
      expect(generation.renderGenerations().length).toBeGreaterThanOrEqual(1);
    }
    // 自機の操作は世代に依らない値を渡す（入力の作法の差は §5.1 で許容済み）
    stepRace(state, input(tick));
    hashes.push(hashRaceState(state));
  }
  return hashes;
}

describe('世代切替に対する不変性', () => {
  it('FC→PS2→SFC→PS1→FC と切り替えても状態ハッシュが完全一致する', () => {
    expect(run(true)).toEqual(run(false));
  });

  it('切替は 350〜600 ms で終わり、その間もレースは進む', () => {
    const state = createRaceState({ seed: 7, autoPilot: true });
    const generation = createGenerationController('FC');
    for (let tick = 0; tick < 400; tick++) stepRace(state);

    const before = state.cars[0]!.progress;
    generation.request('PS2');
    expect(generation.transition.active).toBe(true);
    for (let tick = 0; tick < TRANSITION_TICKS + 2; tick++) {
      generation.advance(1000 / 60);
      stepRace(state);
    }
    expect(generation.transition.active).toBe(false);
    expect(generation.generation).toBe('PS2');
    expect(state.cars[0]!.progress).toBeGreaterThan(before);
  });

  it('sim 層は世代を一切参照しない', () => {
    const simDirectory = join(process.cwd(), 'src/game/sim');
    const files = readdirSync(simDirectory).filter((name) => name.endsWith('.ts'));
    expect(files.length).toBeGreaterThan(0);

    // 世代 ID の直接分岐も、プロファイル参照も、sim には存在してはならない
    const forbidden = [
      /\bGenerationId\b/,
      /\bHardwareGenerationProfile\b/,
      /\bHARDWARE_GENERATION_PROFILES\b/,
      /\bdefineGenerationVariant\b/,
      /['"]FC['"]/,
      /['"]SFC['"]/,
      /['"]PS1['"]/,
      /['"]PS2['"]/,
    ];
    for (const name of files) {
      const source = readFileSync(join(simDirectory, name), 'utf8');
      for (const pattern of forbidden) {
        expect(
          pattern.test(source),
          `${name} が世代へ依存している: ${pattern}`,
        ).toBe(false);
      }
    }
  });
});
