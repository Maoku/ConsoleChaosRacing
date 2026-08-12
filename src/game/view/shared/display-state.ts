import type { GenerationId, HardwareGenerationProfile } from '@console-chaos/engine';

import type { CarState, RaceState } from '../../sim/state.js';
import { quantizedFrame } from './quantize.js';

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
}

export interface DisplaySnapshot {
  /** 量子化されたフレーム番号。同じ番号の間は中身が変わらない */
  readonly frameIndex: number;
  /** 量子化された時刻 [s] */
  readonly seconds: number;
  readonly cars: readonly DisplayCar[];
}

export interface DisplayLatch {
  sample(
    generation: GenerationId,
    profile: HardwareGenerationProfile,
    state: RaceState,
    seconds: number,
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
  };
}

export function createDisplayLatch(): DisplayLatch {
  const perGeneration = new Map<GenerationId, DisplaySnapshot>();

  return {
    sample(generation, profile, state, seconds) {
      const frameIndex = quantizedFrame(seconds, profile);
      const previous = perGeneration.get(generation);
      if (previous && previous.frameIndex === frameIndex) return previous;

      const hz = profile.video.animationHz;
      const snapshot: DisplaySnapshot = {
        frameIndex,
        seconds: hz > 0 ? frameIndex / hz : seconds,
        cars: state.cars.map(copyCar),
      };
      perGeneration.set(generation, snapshot);
      return snapshot;
    },
  };
}
