import type {
  GenerationId,
  HardwareGenerationProfile,
  RenderFrame,
} from '@console-chaos/engine';

import type { RaceState } from '../sim/state.js';
import type { DisplaySnapshot } from './shared/display-state.js';

/**
 * ビューが受け取るすべて。
 *
 * `state` はシムの読み取り専用の窓であり、ビューは絶対に書き換えない。
 * 車の値は `display`（世代の更新レートへ量子化済み）から読む — `state.cars` を
 * 直接読むと 60Hz で動いてしまい、第1世代の 6Hz が出ない。
 */
export interface ViewContext {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly state: RaceState;
  readonly display: DisplaySnapshot;
  /** 実時間の経過秒。量子化済みの時刻は `display.seconds` */
  readonly seconds: number;
}

export type ViewBuilder = (frame: RenderFrame, context: ViewContext) => void;
