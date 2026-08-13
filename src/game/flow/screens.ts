import { mix32 } from '@console-chaos/engine';

import { stepRace } from '../sim/race.js';
import { createRaceState, type RaceState } from '../sim/state.js';
import type { Track } from '../sim/track.js';
import type { VehicleControl } from '../sim/vehicle.js';

/**
 * 画面の状態機械（実装計画 §5.2 / フェーズ 7）。
 *
 * ```
 * title ──決定──> countdown ──> racing ──> finished ──> result ──┬─ リトライ ─> countdown
 *   ▲                                                            └─ タイトルへ ─┐
 *   └────────────────────────────────────────────────────────────────────────────┘
 * ```
 *
 * **この状態機械は世代を知らない。** 世代切替はどの画面でも常時有効で、
 * 切り替えてもここの状態には一切触れない（§6.1 世代横断 4）。
 * ビューも音も同じで、変わるのは「いま何を描くか」だけである。
 *
 * `title` 中も `RaceSim` を AI 8 台で回してアトラクトデモにする。決定へ進むときに
 * シムを**シードから作り直す**ので、デモを何秒眺めていてもレース内容は変わらない
 * （`flow.spec.ts` が固定する）。
 */

export type ScreenId = 'title' | 'countdown' | 'racing' | 'finished' | 'result';

/** ゴールしてからリザルトへ移るまでの間 [tick]。この間もライバルは走り続ける */
export const RESULT_DELAY_TICKS = 180;

export interface FlowInput {
  /** 自機の操作。`title` と `result` では無視される */
  readonly control: VehicleControl;
  /** 決定（この tick の立ち上がりだけ真） */
  readonly confirm: boolean;
  /** 戻る（この tick の立ち上がりだけ真） */
  readonly back: boolean;
  /** ポーズの切り替え（この tick の立ち上がりだけ真） */
  readonly pause: boolean;
}

export interface FlowState {
  screen: ScreenId;
  /** いまの画面に入ってからの tick。点滅や演出の時計になる */
  screenTicks: number;
  /** ポーズ中はシムのティックを止める。世代切替は止めない */
  paused: boolean;
  race: RaceState;
  /** 何度目のレースか。シードを決めるのに使う（0 はアトラクトデモ） */
  raceIndex: number;
  /** ゴールからリザルトまでの残り tick */
  resultDelay: number;
  readonly baseSeed: number;
  readonly track: Track | undefined;
}

export interface FlowTransition {
  readonly from: ScreenId;
  readonly to: ScreenId;
  /** 新しい `RaceState` が作られたか。音の状態を畳むのに使う */
  readonly raceRestarted: boolean;
}

export interface FlowOptions {
  readonly seed?: number;
  readonly track?: Track;
}

const DEFAULT_SEED = 20260813;

/**
 * レースのシードは**何度目のレースか**だけで決まる。
 *
 * アトラクトデモを何 tick 回したかが混ざらないので、
 * 「タイトル画面を眺めていた時間でレース内容が変わる」ことが構造的に起きない。
 */
function seedFor(baseSeed: number, raceIndex: number): number {
  return mix32(baseSeed ^ (raceIndex * 0x9e3779b1)) >>> 0;
}

function newRace(flow: FlowState, autoPilot: boolean): RaceState {
  return createRaceState({
    seed: seedFor(flow.baseSeed, flow.raceIndex),
    autoPilot,
    ...(flow.track ? { track: flow.track } : {}),
  });
}

export function createFlow(options: FlowOptions = {}): FlowState {
  const baseSeed = options.seed ?? DEFAULT_SEED;
  const flow: FlowState = {
    screen: 'title',
    screenTicks: 0,
    paused: false,
    raceIndex: 0,
    resultDelay: RESULT_DELAY_TICKS,
    baseSeed,
    track: options.track,
    // 先に形だけ作って、すぐ下で正しいシードのものへ差し替える
    race: createRaceState({ seed: baseSeed, autoPilot: true, ...(options.track ? { track: options.track } : {}) }),
  };
  flow.race = newRace(flow, true);
  return flow;
}

function enter(flow: FlowState, screen: ScreenId, raceRestarted: boolean): FlowTransition {
  const from = flow.screen;
  flow.screen = screen;
  flow.screenTicks = 0;
  return { from, to: screen, raceRestarted };
}

/** タイトルへ戻る。アトラクトデモを新しく起こす */
function toTitle(flow: FlowState): FlowTransition {
  flow.raceIndex = 0;
  flow.race = newRace(flow, true);
  flow.paused = false;
  flow.resultDelay = RESULT_DELAY_TICKS;
  return enter(flow, 'title', true);
}

/** レースを始める。**ここでシムをシードから作り直す**のがアトラクトの分離点 */
function toCountdown(flow: FlowState): FlowTransition {
  flow.raceIndex += 1;
  flow.race = newRace(flow, false);
  flow.paused = false;
  flow.resultDelay = RESULT_DELAY_TICKS;
  return enter(flow, 'countdown', true);
}

/**
 * 1 ティック進める。戻り値は画面が変わったときだけ。
 *
 * ポーズ中はシムを進めない。ただし `screenTicks` は進めるので、
 * 「PAUSED」の点滅は止まらない。
 */
export function stepFlow(flow: FlowState, input: FlowInput): FlowTransition | null {
  flow.screenTicks += 1;

  switch (flow.screen) {
    case 'title': {
      // アトラクトデモ。AI 8 台が走り、完走したら次のデモを起こす
      stepRace(flow.race);
      if (flow.race.phase === 'finished') flow.race = newRace(flow, true);
      if (input.confirm) return toCountdown(flow);
      return null;
    }

    case 'countdown':
    case 'racing':
    case 'finished': {
      if (input.back) return toTitle(flow);
      if (input.pause) flow.paused = !flow.paused;
      if (flow.paused) {
        if (input.confirm) flow.paused = false;
        return null;
      }

      stepRace(flow.race, input.control);

      if (flow.screen === 'countdown') {
        return flow.race.phase === 'racing' ? enter(flow, 'racing', false) : null;
      }
      if (flow.screen === 'racing') {
        // 自機がゴールした時点で `finished` へ。ライバルはまだ走っている
        return flow.race.cars[0]?.finished ? enter(flow, 'finished', false) : null;
      }
      // finished — 少し余韻を置いてリザルトへ
      flow.resultDelay -= 1;
      return flow.resultDelay <= 0 ? enter(flow, 'result', false) : null;
    }

    case 'result': {
      // リザルト表示中もシムは回す。後続のライバルがゴールしていく画が背景で続く
      if (flow.race.phase !== 'finished') stepRace(flow.race);
      if (input.confirm) return toCountdown(flow);
      if (input.back) return toTitle(flow);
      return null;
    }
  }
}

/** 自機の操作を受け付けている画面か。HUD とビューの出し分けに使う */
export function acceptsDriving(screen: ScreenId): boolean {
  return screen === 'countdown' || screen === 'racing' || screen === 'finished';
}

/** 走行中の HUD を出す画面か。タイトルとリザルトでは出さない */
export function showsRaceHud(screen: ScreenId): boolean {
  return acceptsDriving(screen);
}
