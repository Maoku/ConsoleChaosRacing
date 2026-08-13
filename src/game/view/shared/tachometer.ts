import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import { GEAR_COUNT, gearFor, rpmFor } from '../../audio/engine-sound.js';
import { VEHICLE } from '../../sim/vehicle.js';
import type { DisplayCar } from './display-state.js';
import { FONT_ATLAS } from './font.js';
import type { TextStyle } from './hud.js';
import { textSprites } from './text.js';
import { safeAreaOf } from './variants.js';

/**
 * タコメーター（実装計画 8-3）。**第3・第4世代だけに出す。**
 *
 * アナログのメーターは 3D 世代の HUD の作法であり、第1・第2世代では
 * `translucency` と同時色数の制約にも触れる。世代差は `TACHOMETERS` の 1 表に
 * 置き、FC / SFC は `null` — ビューに世代 ID 分岐を書かない（§1.4）。
 *
 * ## 針とエンジン音が同じ式から出る
 *
 * 針の角度は `audio/engine-sound.ts` の `gearFor()` / `rpmFor()` を**そのまま呼ぶ**。
 * 擬似 4 段のギアが上がるたびに回転が落ちる鋸歯（§4.3）がそのまま針の動きになり、
 * シフトのたびに針が落ちて**音とぴったり合う**。速度は `DisplayLatch` を通した
 * 表示用の値なので、針も 30Hz / 60Hz で止まる。
 *
 * ## 回し方
 *
 * 針は 1 枚のセルを `SpriteCommand.rotation` で回す（実測: `writeSpriteModelMatrix` は
 * スクリーン空間スプライトにも `rotation` を適用する）。角度ごとのセルを焼く必要は無い。
 * スクリーン空間では基底が単位行列なので、**θ が増えるほど時計回り**に回る。
 */

/**
 * 盤のアトラス（`tools/build-gauge.mjs` が焼く）。
 *
 * 2 列 × 2 行。目盛りとレッドゾーンを焼いた盤・針・中央の丸を 1 枚に置く。
 * 4 つ目のセルは空けてある（アトラスのセルは機械的に等分されるので、
 * 正方形の絵を正方形のセルへ入れるにはこの形がいちばん素直）。
 */
export const TACHO_ATLAS = {
  columns: 2,
  rows: 2,
  cells: { dial: 0, needle: 1, hub: 2 },
} as const;

/**
 * 針の振れ幅。真上を 0 として左右対称に ±135°。
 * 生成ツールが目盛りを刻む範囲でもあるので、盤と針は必ず同じ範囲を見る。
 */
export const TACHO_SWEEP = { start: -(Math.PI * 3) / 4, end: (Math.PI * 3) / 4 } as const;

/** ここから上がレッドゾーン（回転数 0..1） */
export const TACHO_REDLINE = 0.8;

export interface TachometerLayout {
  /** アトラスの URL（生成物） */
  readonly url: string;
  /** アトラスの 1 セルの一辺 [px]。生成ツールだけが使う */
  readonly cellSize: number;
  /** 画面上の盤の一辺 [px] */
  readonly size: number;
  /** 盤と速度の数字の間 [px] */
  readonly gap: number;
  /** 盤の中央に出すギア段の拡大率 */
  readonly gearScale: number;
  /** 焼き込む色（生成ツールだけが使う）。実行時の tint は白 1 色 */
  readonly colors: {
    readonly face: readonly [number, number, number];
    readonly rim: readonly [number, number, number];
    readonly tick: readonly [number, number, number];
    readonly redzone: readonly [number, number, number];
    readonly needle: readonly [number, number, number];
    readonly hub: readonly [number, number, number];
  };
}

/**
 * 世代ごとの寸法。**FC / SFC は `null`** — 出さないこと自体が世代差になる。
 * 第4世代だけ盤が大きいのは内部解像度が 2 倍だからで、HUD の拡大率と同じ考え方。
 */
export const TACHOMETERS: GenerationVariant<TachometerLayout | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    url: 'assets/gen3/hud/tacho.png',
    cellSize: 64,
    size: 54,
    gap: 5,
    gearScale: 1,
    colors: {
      face: [18, 26, 38],
      rim: [124, 150, 176],
      tick: [206, 220, 234],
      redzone: [198, 64, 56],
      needle: [240, 208, 120],
      hub: [150, 170, 190],
    },
  },
  PS2: {
    url: 'assets/gen4/hud/tacho.png',
    cellSize: 128,
    size: 96,
    gap: 10,
    gearScale: 2,
    colors: {
      face: [20, 30, 48],
      rim: [150, 178, 208],
      tick: [232, 240, 250],
      redzone: [214, 72, 60],
      needle: [252, 216, 128],
      hub: [172, 194, 214],
    },
  },
});

export function tachometerLayoutFor(generation: GenerationId): TachometerLayout | null {
  return generationValue(TACHOMETERS, generation);
}

/** 盤の矩形。安全領域の左下に置く（ミニマップは右下なので衝突しない） */
export interface TachometerRect {
  readonly left: number;
  readonly top: number;
  readonly size: number;
}

export function tachometerRect(
  generation: GenerationId,
  profile: HardwareGenerationProfile,
): TachometerRect | null {
  const layout = tachometerLayoutFor(generation);
  if (!layout) return null;
  const safe = safeAreaOf(profile);
  return {
    left: Math.round(safe.left),
    top: Math.round(safe.top + safe.height - layout.size),
    size: layout.size,
  };
}

/**
 * 速度の数字を右へ寄せる量 [px]。タコメーターが無い世代では 0。
 * HUD 側（`hud.ts`）がこれを足すだけで左下の 2 つが並ぶ。
 */
export function tachometerAdvance(generation: GenerationId): number {
  const layout = tachometerLayoutFor(generation);
  return layout ? layout.size + layout.gap : 0;
}

/** 回転数 0..1 → 針の角度 [rad]。単調増加であることを `hud.spec.ts` が固定する */
export function needleAngle(rpm: number): number {
  const clamped = Math.min(1, Math.max(0, rpm));
  return TACHO_SWEEP.start + (TACHO_SWEEP.end - TACHO_SWEEP.start) * clamped;
}

export interface TachometerView {
  readonly rect: TachometerRect;
  readonly rpm: number;
  /** 表示するギア段（1..GEAR_COUNT） */
  readonly gear: number;
  readonly angle: number;
  readonly sprites: readonly SpriteCommand[];
}

export interface TachometerOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  /** 表示用に量子化済みの自機。針も表示の更新レートで止まる */
  readonly car: DisplayCar;
  /**
   * 文字と半透明の作法。**HUD から渡してもらう**（`TEXT_STYLES` をここで引くと
   * `hud.ts` との循環 import になる）。盤の色は `TEXT_STYLES` の表と揃う
   */
  readonly style: TextStyle;
  readonly layer?: number;
}

/**
 * 盤・針・中央の丸・ギア段を組み立てる。フレームへは積まない（純関数として検査できる）。
 * `null` を返す世代（FC / SFC）ではコマンドが 1 つも生まれない。
 */
export function buildTachometer(options: TachometerOptions): TachometerView | null {
  const { generation, profile, car, style } = options;
  const layout = tachometerLayoutFor(generation);
  const rect = tachometerRect(generation, profile);
  if (!layout || !rect) return null;

  const layer = options.layer ?? 50;
  const ratio = VEHICLE.MAX_SPEED > 0 ? car.speed / VEHICLE.MAX_SPEED : 0;
  // エンジン音とまったく同じ 2 つの式。針の落ちる瞬間がシフトの音と揃う
  const rpm = rpmFor(ratio);
  const gear = gearFor(ratio) + 1;
  const angle = needleAngle(rpm);

  const center: [number, number, number] = [
    rect.left + rect.size / 2,
    rect.top + rect.size / 2,
    0,
  ];
  const face = (cell: number, suffix: string, rotation = 0): SpriteCommand => ({
    id: `tacho-${generation}-${suffix}`,
    screenSpace: true,
    position: center,
    size: [rect.size, rect.size],
    color: '#ffffff',
    texture: layout.url,
    cell,
    rotation,
    alphaCutoff: 0.5,
    layer,
    generations: [generation],
  });

  const sprites: SpriteCommand[] = [
    // 盤は半透明の作法を `TEXT_STYLES` と揃える（PS1 は average、PS2 は source-over）。
    // 針と中央の丸は不透明のまま — 背景に溶けると読めなくなる
    {
      ...face(TACHO_ATLAS.cells.dial, 'dial'),
      ...(style.panel ? { hardwareBlend: style.panel.blend } : {}),
    },
    face(TACHO_ATLAS.cells.needle, 'needle', angle),
    face(TACHO_ATLAS.cells.hub, 'hub'),
  ];

  // ギア段は盤の中央より少し下。針の付け根と重ならない位置に置く
  const gearHeight = FONT_ATLAS.glyphHeight * layout.gearScale;
  for (const sprite of textSprites({
    id: `tacho-${generation}-gear`,
    text: String(Math.min(GEAR_COUNT, gear)),
    generation,
    profile,
    x: rect.left + rect.size / 2,
    y: Math.round(rect.top + rect.size * 0.62 - gearHeight / 2),
    align: 'center',
    color: style.value,
    scale: layout.gearScale,
    shadow: style.shadow,
    layer: layer + 1,
  })) {
    sprites.push(sprite);
  }

  return { rect, rpm, gear, angle, sprites };
}
