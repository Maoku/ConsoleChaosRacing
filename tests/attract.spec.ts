import { FIXED_HZ } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import {
  ATTRACT,
  ATTRACT_GENERATION_TICKS,
  ATTRACT_IDLE_TICKS,
  anyInputIn,
  createAttract,
  stepAttract,
  type AttractState,
} from '../src/game/flow/attract.js';
import { createFlow, stepFlow, type ScreenId } from '../src/game/flow/screens.js';
import { LAP_COUNT } from '../src/game/sim/state.js';

/**
 * タイトルのアトラクト（実装計画 11-6 / R-6）。
 *
 * 改修前は放置しても第1世代のままだった（世代の切り替えは Q / E / 1〜4 の手動だけ）。
 * 「ゴールしたらリスタート」のほうは `stepFlow()` に既にあるので、
 * ここではそれをテストで固定するだけにする。
 */

const IDLE: { readonly screen: ScreenId; readonly anyInput: boolean } = {
  screen: 'title',
  anyInput: false,
};

/** `ticks` ティック放置して、世代の送りが起きたティックを列挙する */
function advances(state: AttractState, ticks: number, screen: ScreenId = 'title'): number[] {
  const at: number[] = [];
  for (let tick = 1; tick <= ticks; tick++) {
    if (stepAttract(state, { screen, anyInput: false })) at.push(tick);
  }
  return at;
}

describe('アトラクトの世代巡回', () => {
  it('無操作 5 秒で始まり、以後 5 秒ごとに次の世代を要求する', () => {
    expect(ATTRACT.IDLE_SECONDS).toBe(5);
    expect(ATTRACT.GENERATION_SECONDS).toBe(5);
    const state = createAttract();
    // 30 秒放置 ＝ 5 秒目に巡回が始まり、以後 5 秒ごと。4 世代なので 30 秒で 1 巡半する
    expect(advances(state, 30 * FIXED_HZ)).toEqual([
      ATTRACT_IDLE_TICKS,
      ATTRACT_IDLE_TICKS + ATTRACT_GENERATION_TICKS,
      ATTRACT_IDLE_TICKS + ATTRACT_GENERATION_TICKS * 2,
      ATTRACT_IDLE_TICKS + ATTRACT_GENERATION_TICKS * 3,
      ATTRACT_IDLE_TICKS + ATTRACT_GENERATION_TICKS * 4,
      ATTRACT_IDLE_TICKS + ATTRACT_GENERATION_TICKS * 5,
    ]);
  });

  it('5 秒に 1 ティックでも足りないと始まらない', () => {
    const state = createAttract();
    expect(advances(state, ATTRACT_IDLE_TICKS - 1)).toEqual([]);
    expect(state.cycling).toBe(false);
  });

  it('操作があったら巡回が止まり、無操作の計測がやり直される', () => {
    const state = createAttract();
    advances(state, ATTRACT_IDLE_TICKS + 100);
    expect(state.cycling).toBe(true);

    expect(stepAttract(state, { screen: 'title', anyInput: true })).toBe(false);
    expect(state.cycling).toBe(false);
    expect(state.idleTicks).toBe(0);

    // 抜けた直後は、また 5 秒たっぷり待つ
    expect(advances(state, ATTRACT_IDLE_TICKS - 1)).toEqual([]);
    expect(stepAttract(state, IDLE)).toBe(true);
  });

  it('タイトル以外の画面では巡回しない', () => {
    for (const screen of ['countdown', 'racing', 'finished', 'result'] as const) {
      const state = createAttract();
      expect(advances(state, 30 * FIXED_HZ, screen)).toEqual([]);
      expect(state.cycling).toBe(false);
      expect(state.idleTicks).toBe(0);
    }
  });

  it('タイトルを離れると巡回中でも畳まれる', () => {
    const state = createAttract();
    advances(state, ATTRACT_IDLE_TICKS + 60);
    expect(state.cycling).toBe(true);
    expect(stepAttract(state, { screen: 'racing', anyInput: false })).toBe(false);
    expect(state.cycling).toBe(false);
  });

  describe('操作の拾い方', () => {
    const snapshot = (
      keys: string[] = [],
      buttons: [number, number][] = [],
      axes: number[] = [],
    ) => ({
      keys: new Set(keys),
      gamepadButtons: new Map(buttons),
      gamepadAxes: axes,
    });

    it('アクションに割り当てていないキーでも「操作あり」になる', () => {
      expect(anyInputIn(snapshot(['KeyJ']))).toBe(true);
      expect(anyInputIn(snapshot())).toBe(false);
    });

    it('ゲームパッドのボタンとスティックも拾う', () => {
      expect(anyInputIn(snapshot([], [[0, 1]]))).toBe(true);
      expect(anyInputIn(snapshot([], [], [0.8]))).toBe(true);
    });

    it('スティックの遊びは操作とみなさない（ドリフトで抜けない）', () => {
      expect(anyInputIn(snapshot([], [[0, 0.1]], [0.2, -0.3]))).toBe(false);
    });
  });
});

describe('アトラクトのデモ', () => {
  it('デモのレースが完走したら作り直される（画面はタイトルのまま）', () => {
    const flow = createFlow();
    const first = flow.race;
    // 3 周を完走するまで回す。1 レース 240 秒ほどなので上限は余裕を採る
    let restarted = false;
    for (let tick = 0; tick < 60 * 400 && !restarted; tick++) {
      stepFlow(flow, { control: { steer: 0, throttle: 0, brake: 0 }, confirm: false, back: false, pause: false });
      restarted = flow.race !== first;
    }
    expect(restarted, 'デモが作り直されなかった').toBe(true);
    expect(flow.screen).toBe('title');
    // 作り直したレースも AI 8 台のデモ（自機も AI が走らせる）
    expect(flow.race.autoPilot).toBe(true);
    expect(flow.race.phase).toBe('countdown');
    expect(flow.raceIndex).toBe(0);
  }, 30_000);

  it('作り直したデモは同じレースになる（シードは raceIndex だけで決まる）', () => {
    const flow = createFlow();
    const first = flow.race;
    for (let tick = 0; tick < 60 * 400 && flow.race === first; tick++) {
      stepFlow(flow, { control: { steer: 0, throttle: 0, brake: 0 }, confirm: false, back: false, pause: false });
    }
    expect(flow.race).not.toBe(first);
    // **同じシード**。タイトルを何秒眺めてもレースの内容が変わらない、という
    // 既存の不変条件（`flow.spec.ts`）をループでも保つ（§9-4）
    expect(flow.race.seed).toBe(first.seed);
    // 完走まで走ったから作り直されたのであって、途中で切り上げたのではない
    expect(first.phase).toBe('finished');
    expect(first.cars.every((car) => car.lap > LAP_COUNT)).toBe(true);
  }, 30_000);
});
