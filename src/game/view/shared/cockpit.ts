import type {
  GenerationId,
  HardwareGenerationProfile,
  SpriteCommand,
} from '@console-chaos/engine';

import { cameraViewsFor } from './camera.js';
import type { DisplayCar } from './display-state.js';

/**
 * 内装（実装計画 8-5 の `cockpit`）。**第4世代だけ。**
 *
 * カメラは `windshield` と同じで、違いはスクリーン空間スプライトを被せることだけ。
 * ダッシュボード・A ピラー・ルーフを 1 枚に焼き、窓は `alphaCutoff` で抜く。
 * ステアリングは別の 1 枚で、`SpriteCommand.rotation` を舵角ぶん回す
 * （タコメーターの針と同じ仕組み）。
 *
 * **第4世代だけ**にしてあるのは、640×448・linear フィルタ・GS alpha が揃って
 * 初めて内装が絵として成立するからで（320×240 では帯にしか見えない）、
 * 出せないこと自体が世代差の表現になる。
 */

/**
 * 内装のアトラス。1 セル 1 枚で、画面と同じ縦横比（640×448）に焼く。
 * `tools/build-cockpit.mjs` が生成する。
 */
export const COCKPIT_ATLAS = {
  url: 'assets/gen4/hud/cockpit.png',
  columns: 1,
  rows: 1,
  width: 640,
  height: 448,
} as const;

/**
 * ステアリング。**内装と分けてあるのは回す中心のため** — 回転はスプライトの中心
 * まわりに掛かるので、画面全体を覆う 1 枚に描き込むと画面中央を軸に回ってしまう。
 */
export const WHEEL_ATLAS = {
  url: 'assets/gen4/hud/wheel.png',
  columns: 1,
  rows: 1,
  size: 256,
} as const;

/** ステアリングの配置。画面の幅・高さに対する割合で持つ */
export const WHEEL_LAYOUT = {
  /** 画面幅に対する直径 */
  sizeFraction: 0.42,
  /** 中心の X（画面幅に対する割合） */
  centerX: 0.5,
  /** 中心の Y（画面高に対する割合）。下端から少しはみ出す */
  centerY: 1.02,
  /** 舵いっぱいで回る角度 [rad] */
  maxAngle: Math.PI / 3,
} as const;

/**
 * 内装を出せる世代か。**世代 ID を直接見ずに `CAMERA_VIEWS` の表から導く**（§1.4）。
 * 視点の表に `cockpit` を足せば、この関数も manifest もそのまま追従する。
 */
export function cockpitAvailable(generation: GenerationId): boolean {
  return cameraViewsFor(generation).includes('cockpit');
}

export interface CockpitOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  /** 表示用に量子化済みの自機。舵角も表示の更新レートで止まる */
  readonly car: DisplayCar;
  readonly layer?: number;
}

/**
 * 内装 ＋ ステアリングのスプライト。積む順がそのまま重ね順で、
 * HUD より先（＝奥）に積む — 数字とミニマップは内装の上に出る。
 */
export function cockpitSprites(options: CockpitOptions): SpriteCommand[] {
  const { generation, profile, car } = options;
  if (!cockpitAvailable(generation)) return [];

  const width = profile.video.internalWidth;
  const height = profile.video.internalHeight;
  const layer = options.layer ?? 45;
  const wheelSize = Math.round(width * WHEEL_LAYOUT.sizeFraction);
  // 舵角そのものはシムが持たないので、車体の横加速度ではなく**操舵の見た目**として
  // 横方向の傾きから作る。値域は ±1 に収める
  const steer = Math.max(-1, Math.min(1, car.lateralAccel / 12));

  return [
    {
      id: `cockpit-${generation}-interior`,
      screenSpace: true,
      position: [width / 2, height / 2, 0],
      size: [width, height],
      color: '#ffffff',
      texture: COCKPIT_ATLAS.url,
      cell: 0,
      // 窓は透明に焼いてある。半端な α を作っていないので、しきい値で完全に抜ける
      alphaCutoff: 0.5,
      layer,
      generations: [generation],
    },
    {
      id: `cockpit-${generation}-wheel`,
      screenSpace: true,
      position: [
        Math.round(width * WHEEL_LAYOUT.centerX),
        Math.round(height * WHEEL_LAYOUT.centerY),
        0,
      ],
      size: [wheelSize, wheelSize],
      color: '#ffffff',
      texture: WHEEL_ATLAS.url,
      cell: 0,
      rotation: steer * WHEEL_LAYOUT.maxAngle,
      alphaCutoff: 0.5,
      layer: layer + 1,
      generations: [generation],
    },
  ];
}
