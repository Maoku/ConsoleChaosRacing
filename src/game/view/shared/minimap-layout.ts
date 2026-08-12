import { defineGenerationVariant, type GenerationVariant } from '@console-chaos/engine';

import type { TrackBounds } from '../../sim/track.js';

/**
 * ミニマップの座標系（実装計画 §3.6）。
 *
 * **このファイルはゲーム本体と `tools/build-minimap.mjs` の両方から import される。**
 * 俯瞰図テクスチャを描くのも、実行時にマーカーを置くのも同じ関数なので、
 * 2 つがずれる余地が構造的に無い。
 */

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
  /** 背景パネルの色。`panelAlpha` が 0 なら描かない */
  readonly panelColor: readonly [number, number, number];
  /**
   * 背景パネルの不透明度 0..1。
   *
   * **エンジン実測**: スプライト面の α は 0.5 のしきい値で「描く／描かない」に
   * 二値化される（`quantize_fc` / `quantize_sfc` のシェーダに
   * 「抜きは 0 か 255 しかない」と明記）。板メッシュ側も半透明パスの合成が
   * 加算なので暗いパネルは作れない。つまり**半透明パネルはこのレンダラーでは
   * 表現できない**。パネルは不透明で焼き、色のほうを「半透明に見える濃さ」に寄せる。
   * 0 は「パネルを置かない」を意味する（FC の `alphaBlend: false` 契約）。
   */
  readonly panelAlpha: number;
  /** パネルの縁を落とす幅 [px]。しきい値で切られるので、ぼけではなく角の削れになる */
  readonly panelFade: number;
}

/**
 * 世代ごとの寸法と色。表現の差はここだけに集約し、位置の計算は 4 世代で完全に同じ。
 * 解像度・色数・更新レートの制約を通して同じ 8 台がどう変わるかがそのまま見える。
 *
 * FC にパネルが無いのは能力契約（`alphaBlend: false`）を守るため。輪郭線だけを置く。
 * 他の 3 世代のパネルは不透明で焼く（`panelAlpha` の注記）。
 */
export const MINIMAP_LAYOUTS: GenerationVariant<MinimapLayout> = defineGenerationVariant({
  FC: {
    size: 56,
    margin: 3,
    lineWidth: 1,
    markerSize: 2,
    hardEdges: true,
    lineColor: [252, 252, 252],
    panelColor: [0, 0, 0],
    panelAlpha: 0,
    panelFade: 0,
  },
  SFC: {
    size: 72,
    margin: 4,
    lineWidth: 2,
    markerSize: 3,
    hardEdges: true,
    lineColor: [248, 248, 248],
    panelColor: [26, 32, 56],
    panelAlpha: 1,
    panelFade: 0,
  },
  PS1: {
    size: 88,
    margin: 5,
    lineWidth: 2,
    markerSize: 4,
    hardEdges: false,
    lineColor: [216, 228, 240],
    panelColor: [22, 30, 42],
    panelAlpha: 1,
    panelFade: 0,
  },
  PS2: {
    size: 176,
    margin: 8,
    lineWidth: 3,
    markerSize: 6,
    hardEdges: false,
    lineColor: [232, 240, 248],
    panelColor: [18, 26, 42],
    panelAlpha: 1,
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
