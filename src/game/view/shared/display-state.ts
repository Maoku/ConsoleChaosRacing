import type { GenerationId, HardwareGenerationProfile } from '@console-chaos/engine';

import type { CarState, RaceState } from '../../sim/state.js';
import { displayFrameForTick } from './quantize.js';

/**
 * 「見た目の更新レート」のためのラッチ（実装計画 §3 冒頭）。
 *
 * シムは常に 60Hz で回る。ビューが読むのは、その世代の `animationHz` の境目で
 * 掛け値なしに写し取った**スナップショット**だけである。第1世代は 10 ティックに 1 回、
 * 第3世代は 2 ティックに 1 回しか値が変わらない。
 *
 * これはビューだけが持つ状態であり、捨てても破綻しない（§2.1）。
 * 世代ごとに別のラッチを持つので、切替演出中に 2 世代を同時に描いても
 * それぞれのレートで正しく止まって見える。
 */

/** ビューが読む車の値。`CarState` はこれを構造的に満たす */
export interface DisplayCar {
  readonly entrant: number;
  readonly s: number;
  readonly lateral: number;
  readonly yaw: number;
  readonly speed: number;
  readonly standing: number;
  readonly lap: number;
  readonly offTrack: boolean;
  readonly lateralAccel: number;
  readonly longitudinalAccel: number;
  /**
   * ブレーキの踏み量 0..1（フェーズ 12-7）。テールランプの明るさがこれで決まる。
   *
   * 減速度（`longitudinalAccel`）では代用できない。アクセルを離しただけでも負になるし、
   * **他車のブレーキは AI の入力そのもの**だからで、8 台ぶんが等しく必要になる。
   */
  readonly brakeInput: number;
  // ── HUD が読む値。ラップタイムも表示の更新レートで止まる（実装計画 §3.5）
  /** 現在の周が始まった tick。まだラインを越えていなければ -1 */
  readonly lapStartTick: number;
  /** ベストラップのティック数。未計測は -1 */
  readonly bestLapTicks: number;
  readonly finished: boolean;
}

export interface DisplaySnapshot {
  /** 量子化されたフレーム番号。同じ番号の間は中身が変わらない */
  readonly frameIndex: number;
  /** 量子化された時刻 [s] */
  readonly seconds: number;
  /**
   * この写しを取ったときのシムのティック。
   *
   * ラップタイムの表示はこれと `lapStartTick` の差で作る。`RaceState.tick` を
   * 直接引くと**時計だけが 60Hz で動いてしまい**、第1世代で車が 6Hz なのに
   * ミリ秒表示だけがなめらかに回る、という食い違いが出る。
   */
  readonly tick: number;
  /** カウントダウンの残り tick。`RacePhase` の遷移も表示のレートで見える */
  readonly countdown: number;
  readonly cars: readonly DisplayCar[];
}

export interface DisplayLatch {
  sample(
    generation: GenerationId,
    profile: HardwareGenerationProfile,
    state: RaceState,
  ): DisplaySnapshot;
}

function copyCar(car: CarState): DisplayCar {
  return {
    entrant: car.entrant,
    s: car.s,
    lateral: car.lateral,
    yaw: car.yaw,
    speed: car.speed,
    standing: car.standing,
    lap: car.lap,
    offTrack: car.offTrack,
    lateralAccel: car.lateralAccel,
    longitudinalAccel: car.longitudinalAccel,
    brakeInput: car.brakeInput,
    lapStartTick: car.lapStartTick,
    bestLapTicks: car.bestLapTicks,
    finished: car.finished,
  };
}

export function createDisplayLatch(): DisplayLatch {
  const perGeneration = new Map<GenerationId, DisplaySnapshot>();

  return {
    sample(generation, profile, state) {
      // シムのティックから整数演算で求める。秒から割ると境目で 1 フレーム落ちる
      const frameIndex = displayFrameForTick(state.tick, profile);
      const previous = perGeneration.get(generation);
      if (previous && previous.frameIndex === frameIndex) return previous;

      const hz = profile.video.animationHz;
      const snapshot: DisplaySnapshot = {
        frameIndex,
        seconds: hz > 0 ? frameIndex / hz : state.tick / 60,
        tick: state.tick,
        countdown: state.countdown,
        cars: state.cars.map(copyCar),
      };
      perGeneration.set(generation, snapshot);
      return snapshot;
    },
  };
}
