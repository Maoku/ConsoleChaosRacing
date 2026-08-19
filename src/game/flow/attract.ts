import { FIXED_HZ } from '@console-chaos/engine';

import type { ScreenId } from './screens.js';

/**
 * タイトルのアトラクト（実装計画 11-6 / R-6 / D-12）。
 *
 * **持つ状態は 2 つだけ** — 無操作が何ティック続いたかと、いまの世代を何ティック
 * 見せたか。世代を切り替えるのは呼び手（`module.ts`）の仕事で、ここは
 * 「そろそろ次へ」と言うだけの純粋な関数にしてある。
 *
 * 巡回は `title` 画面だけ。**操作があったら即座に抜け、無操作の計測をやり直す。**
 * 抜けた時点の世代はそのままにする（勝手に第1世代へ戻さない）。
 *
 * デモのレースが完走したら作り直す処理は `stepFlow()` の `title` 分岐に既にある。
 * シードは `raceIndex = 0` のままなので、**デモは毎回同じレースを繰り返す** —
 * 「タイトルを眺めた長さがレースの内容を変えない」という不変条件（`flow.spec.ts`）が
 * そのまま保たれる（§9-4）。
 */

export const ATTRACT = {
  /** これだけ無操作が続いたら世代の巡回を始める [s] */
  IDLE_SECONDS: 5,
  /** 1 世代を見せる長さ [s] */
  GENERATION_SECONDS: 5,
} as const;

export const ATTRACT_IDLE_TICKS = ATTRACT.IDLE_SECONDS * FIXED_HZ;
export const ATTRACT_GENERATION_TICKS = ATTRACT.GENERATION_SECONDS * FIXED_HZ;

export interface AttractState {
  /** 無操作が続いたティック数 */
  idleTicks: number;
  /** いまの世代を見せているティック数。巡回中だけ進む */
  showTicks: number;
  /** 世代の巡回中か */
  cycling: boolean;
}

export interface AttractInput {
  readonly screen: ScreenId;
  /**
   * 何か操作があったか。**アクションに割り当てていないキーでも真**にする —
   * 放置の判定なので広く採る。
   */
  readonly anyInput: boolean;
}

export function createAttract(): AttractState {
  return { idleTicks: 0, showTicks: 0, cycling: false };
}

function reset(state: AttractState): void {
  state.idleTicks = 0;
  state.showTicks = 0;
  state.cycling = false;
}

/**
 * 1 ティック進める。**戻り値が真なら「次の世代へ」。**
 *
 * 送りは呼び手が `context.generation.cycle(1)` で行う。手動の Q / E と
 * 同じ経路を通るので、切替演出も BGM の位相保存も追加のコストが無い。
 */
export function stepAttract(state: AttractState, input: AttractInput): boolean {
  // レース中は巡回しない。タイトルを離れたら状態を畳む
  if (input.screen !== 'title') {
    reset(state);
    return false;
  }
  if (input.anyInput) {
    reset(state);
    return false;
  }

  state.idleTicks += 1;
  if (!state.cycling) {
    if (state.idleTicks < ATTRACT_IDLE_TICKS) return false;
    state.cycling = true;
    state.showTicks = 0;
    return true;
  }

  state.showTicks += 1;
  if (state.showTicks < ATTRACT_GENERATION_TICKS) return false;
  state.showTicks = 0;
  return true;
}

/** 何か操作があったか。世代巡回を抜ける判定に使う（広く採る） */
export function anyInputIn(snapshot: {
  readonly keys: ReadonlySet<string>;
  readonly gamepadButtons: ReadonlyMap<number, number>;
  readonly gamepadAxes: readonly number[];
}): boolean {
  if (snapshot.keys.size > 0) return true;
  for (const value of snapshot.gamepadButtons.values()) if (value > 0.25) return true;
  // スティックの遊びは操作とみなさない（放置中にドリフトで抜けてしまう）
  for (const axis of snapshot.gamepadAxes) if (Math.abs(axis) > 0.35) return true;
  return false;
}
