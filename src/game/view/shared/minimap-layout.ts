import {
  defineGenerationVariant,
  type GenerationVariant,
  type HardwareBlendCommand,
} from '@console-chaos/engine';

import type { TrackBounds } from '../../sim/track.js';

/**
 * ミニマップの座標系（実装計画 §3.6）。
 *
 * **このファイルはゲーム本体と `tools/build-minimap.mjs` の両方から import される。**
 * 俯瞰図テクスチャを描くのも、実行時にマーカーを置くのも同じ関数なので、
 * 2 つがずれる余地が構造的に無い。
 */

/**
 * 共通の小さな形のアトラス（`tools/build-minimap.mjs` が生成する）。
 *
 * サイズはコマンド側で指定するので、この 1 枚で 4 世代・8 台のマーカーも、
 * 落ち影も、画面を覆う帯も賄える。**スプライトはアトラス経由でしか描けない**
 * （エンジンの制約）ため、単色の矩形を出したいだけの場所もここを通る。
 */
export const MARKER_ATLAS = {
  url: 'assets/common/markers.png',
  columns: 3,
  rows: 1,
  /** 丸（他車・落ち影）/ 四角（自機）/ 塗りつぶし（帯・パネル） */
  cells: { rival: 0, player: 1, fill: 2 },
} as const;

export interface MinimapLayout {
  /** テクスチャの一辺 [px] */
  readonly size: number;
  /** 枠から内側へ空ける余白 [px] */
  readonly margin: number;
  /** コース輪郭線の太さ [px] */
  readonly lineWidth: number;
  /** 車マーカーの一辺 [px] */
  readonly markerSize: number;
  /** テクスチャをアンチエイリアス無しで描くか（色数制約のある世代） */
  readonly hardEdges: boolean;
  /** 輪郭線の色。テクスチャへ焼き込む */
  readonly lineColor: readonly [number, number, number];
  /**
   * 背景パネルの色。`null` ならパネルを置かない。
   *
   * テクスチャには**不透明で**焼く。半透明にするのは実行時の `panelBlend` の役目で、
   * ハードウェアごとの半透明の作法（SFC の color math、PS1 の 4 固定モード、
   * PS2 の GS プリセット）をそのまま使うためである。
   */
  readonly panelColor: readonly [number, number, number] | null;
  /**
   * パネルを画面へ合成するときの半透明指定（エンジン 0.2.0 の `HardwareBlendCommand`）。
   *
   * `null` は不透明。FC は `translucency.kind === 'none'` なのでパネル自体を置かない。
   * ここに世代固有の family を書くので、コマンドの `generations` を必ずその世代に絞る
   * （`assertHardwareBlendGenerations` が食い違いを実行時に弾く）。
   */
  readonly panelBlend: HardwareBlendCommand | null;
  /** パネルの縁を落とす幅 [px]。テクスチャの α 勾配として焼く */
  readonly panelFade: number;
}

/**
 * 世代ごとの寸法と色。表現の差はここだけに集約し、位置の計算は 4 世代で完全に同じ。
 * 解像度・色数・更新レートの制約を通して同じ 8 台がどう変わるかがそのまま見える。
 *
 * FC にパネルが無いのは能力契約（`translucency.kind === 'none'`）を守るため。輪郭線だけを置く。
 * SFC 以降は各世代の実機の作法で半透明にする — SFC は RGB555 の color math（加算・half）、
 * PS1 は 4 固定係数のうち average、PS2 は GS の source-over に不透明度を与える。
 */
export const MINIMAP_LAYOUTS: GenerationVariant<MinimapLayout> = defineGenerationVariant({
  FC: {
    size: 56,
    margin: 3,
    lineWidth: 1,
    markerSize: 2,
    hardEdges: true,
    lineColor: [252, 252, 252],
    panelColor: null,
    panelBlend: null,
    panelFade: 0,
  },
  SFC: {
    size: 72,
    margin: 4,
    lineWidth: 2,
    markerSize: 3,
    hardEdges: true,
    lineColor: [248, 248, 248],
    panelColor: [40, 52, 96],
    // 実機の half color math。main と sub を足して 1/2 にする ＝ 50% の重ね合わせ
    panelBlend: { family: 'gen2-color-math', operation: 'add', half: true, operand: 'subscreen' },
    panelFade: 0,
  },
  PS1: {
    size: 88,
    margin: 5,
    lineWidth: 2,
    markerSize: 4,
    hardEdges: false,
    lineColor: [216, 228, 240],
    panelColor: [30, 42, 60],
    // 4 固定係数のうち average（0.5B + 0.5F）
    panelBlend: { family: 'gen3-semitransparency', mode: 'average' },
    panelFade: 0,
  },
  PS2: {
    size: 176,
    margin: 8,
    lineWidth: 3,
    markerSize: 6,
    hardEdges: false,
    lineColor: [232, 240, 248],
    panelColor: [22, 32, 52],
    // GS の alpha blending。任意の不透明度を出せるのは 4 世代でこの世代だけ
    panelBlend: { family: 'gen4-gs', preset: 'source-over', opacity: 0.62 },
    panelFade: 6,
  },
});

export interface MinimapRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface MinimapProjection {
  readonly bounds: TrackBounds;
  /** ワールド [m] → 画素の倍率 */
  readonly scale: number;
  /** bounds.min が写る画素座標 */
  readonly originX: number;
  readonly originY: number;
  /** 描画に使われる実寸 [px] */
  readonly drawWidth: number;
  readonly drawHeight: number;
}

/**
 * コースの AABB を矩形の内側へ、**縦横比を保ったまま**収める。
 *
 * 引き伸ばさないので、どの世代のミニマップでもコースの形が同じに見える。
 * これが「同じコースを 4 通りに描いている」という主張の前提になる。
 */
export function minimapProjection(
  bounds: TrackBounds,
  rect: MinimapRect,
  margin: number,
): MinimapProjection {
  const innerWidth = rect.width - margin * 2;
  const innerHeight = rect.height - margin * 2;
  const scale = Math.min(innerWidth / bounds.size[0], innerHeight / bounds.size[1]);
  const drawWidth = bounds.size[0] * scale;
  const drawHeight = bounds.size[1] * scale;
  return {
    bounds,
    scale,
    originX: rect.left + margin + (innerWidth - drawWidth) / 2,
    originY: rect.top + margin + (innerHeight - drawHeight) / 2,
    drawWidth,
    drawHeight,
  };
}

/** ワールド XZ → ミニマップの画素座標 */
export function minimapPoint(
  projection: MinimapProjection,
  worldX: number,
  worldZ: number,
): [number, number] {
  return [
    projection.originX + (worldX - projection.bounds.min[0]) * projection.scale,
    projection.originY + (worldZ - projection.bounds.min[1]) * projection.scale,
  ];
}

/**
 * ワールド XZ → 正規化座標 0..1。
 *
 * 矩形の大きさにも余白にも依らないので、**4 世代で完全に一致する**。
 * `minimap.spec.ts` が固定するのはこの値であり、
 * 「1 つのシミュレーションが動いている」ことの機械的な担保になる。
 */
export function minimapNormalized(
  bounds: TrackBounds,
  worldX: number,
  worldZ: number,
): [number, number] {
  return [
    (worldX - bounds.min[0]) / bounds.size[0],
    (worldZ - bounds.min[1]) / bounds.size[1],
  ];
}

/** テクスチャ 1 枚ぶんの矩形（生成ツールが使う） */
export function textureRect(size: number): MinimapRect {
  return { left: 0, top: 0, width: size, height: size };
}
