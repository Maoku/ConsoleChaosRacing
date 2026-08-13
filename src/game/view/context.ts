import type {
  GenerationId,
  HardwareGenerationProfile,
  RenderFrame,
} from '@console-chaos/engine';

import type { ScreenId } from '../flow/screens.js';
import type { RaceState } from '../sim/state.js';
import type { CameraViewId } from './shared/camera.js';
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
  /**
   * このフレームで積む世代の数。切替演出中だけ 2 になる。
   *
   * 世代 ID の分岐には使わない。**負荷の予算**を知りたいビュー
   * （走査線ごとにドローコールを出す第2世代）が帯の粒度を落とすのに使う。
   */
  readonly renderedGenerations: number;
  /**
   * いま出ている画面（実装計画 §5.2）。
   *
   * **世代 ID の分岐ではない。** タイトル・カウントダウン・リザルトは 4 世代とも
   * 同じ組み立てで描かれ、世代差は variant テーブルが持つ。
   */
  readonly screen: ScreenId;
  /** その画面に入ってからの tick。点滅や演出の時計 */
  readonly screenTicks: number;
  readonly paused: boolean;
  /**
   * 視点（実装計画 8-5）。**「見た目のためだけの状態」**（§2.1）であり、
   * シムへは一切渡らない。`module.ts` が 1 つ持ち、各ビューは
   * `resolveCameraView()` で自分の世代にある視点へ落としてから使う。
   * 省略時は追走視点 — 視点を知らないテストやビューはこれまでどおり動く。
   */
  readonly cameraView?: CameraViewId;
}

export type ViewBuilder = (frame: RenderFrame, context: ViewContext) => void;
