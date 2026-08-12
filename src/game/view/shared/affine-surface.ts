import type { AffineSurfaceCommand, GenerationId } from '@console-chaos/engine';

import type { RoadView } from './projection.js';
import { patternPeriodMeters } from './road-surface.js';

/**
 * 走査線ごとのアフィン変換による擬似3D（実装計画 §3.3）。第2世代の路面はこれ 1 本で出る。
 *
 * アフィン変換は 1 枚では透視にならない。実機（Mode 7）は HDMA で**走査線ごとに
 * パラメータを書き換えて**透視を作っていたので、ここでも同じ構造にする —
 * `AffineSurfaceCommand` を 1 行につき 1 枚積む。
 *
 * ## エンジンが読む値
 *
 * シェーダは矩形の左上を原点とする局所座標 `local` から
 *
 *     uv = uvOrigin + uvStepX · local.x + uvStepY · local.y
 *
 * を引く（`affineUvAt` が同じ式の CPU 参照）。`uvStepX` は **Vec2** であり、
 * 「画面を右へ 1 px 進んだときの U と V の進み」を別々に指定できる。
 * V 成分がコーナーでの視界の傾きになる。
 *
 * ## 1 行ぶんの導出
 *
 * カメラ空間で、行が見ている距離を z、焦点距離を f とすると、画面を右へ 1 px 進むのは
 * 路面上を `z / f` メートル横へ動くことにあたる。前方の路面の向きが視線から φ だけ
 * 回っていれば、その横移動は路面の座標系では
 *
 *     路面の横方向へ  cos φ · (z/f) [m]   → U へ  cos φ · (z/f) / TEX_W
 *     路面の進行方向へ sin φ · (z/f) [m]  → V へ  sin φ · (z/f) / TEX_L
 *
 * と分解される。U の原点は「画面中央が引く U」（＝ `textureCenterAt`）から
 * 半画面ぶん戻せばよい。**第1世代のラスターと同じ量を、同じ `RoadView` から引いている** —
 * 表現手法が違うだけで、投影は 1 つである。
 *
 * ## V を [0, 1) の内側へ寄せる
 *
 * `wrap` は `clamp` にする。`repeat` だと、コーナーの先で U が範囲を出たときに
 * **二本目の道路**が画面の端に現れてしまう（第1世代と同じ理由）。
 * ただし clamp は V にも掛かるので、傾けた行の V が端を越えると模様が潰れる。
 *
 * 路面テクスチャは V 方向に `patternPeriodMeters` ごとの繰り返しなので、
 * **V を 1 周期単位でずらしても絵は変わらない**。この性質を使って、行の V 範囲が
 * テクスチャの中央へ来るようにずらす。1 枚に 4 周期入れてあるのは、この遊びのため。
 */

/** 帯の粒度。1 行 = 1 サーフェスが基本で、負荷が要るときだけ粗くする */
export const AFFINE_BAND_ROWS = {
  /** 走査線ごと。実機の HDMA と同じ粒度 */
  detailed: 1,
  /** 2 行ずつ。世代切替中は 2 世代ぶんのコマンドを積むので、こちらへ落とす */
  coarse: 2,
} as const;

/**
 * 帯の粒度を決める。切替演出中（2 世代ぶんを積むフレーム）は粗くする。
 * ドローコール予算は 240（§6.3）で、1 行粒度なら 1 世代あたり 135 本になる。
 */
export function affineBandRows(renderGenerations: number): number {
  return renderGenerations > 1 ? AFFINE_BAND_ROWS.coarse : AFFINE_BAND_ROWS.detailed;
}

/**
 * 視界の傾きの上限 [rad]。
 *
 * 前方の路面の向きをそのまま使うとヘアピンで 90° 近くまで回り、遠方の行が
 * 路面のはるか先を引いてしまう。**傾きは「コーナーに入った」ことを伝える演出**なので、
 * 効きを抑えたうえで頭打ちにする。
 */
const MAX_TILT = 0.3;
const TILT_GAIN = 0.7;

/**
 * 1 行の V がテクスチャの中で動ける幅。中央へ寄せたうえで ±0.25 の余裕を残す。
 * ここに当たるのは最遠のごく数行だけで、そこはフォグでほぼ見えない。
 */
const MAX_V_SPAN = 0.5;

export interface AffineRoadOptions {
  readonly generation: GenerationId;
  readonly view: RoadView;
  /** 1 枚のサーフェスが受け持つ行数。`affineBandRows()` で決める */
  readonly bandRows?: number;
}

/**
 * 路面帯をアフィンサーフェスの列に変換する。フレームへは積まない
 * （テストが純関数として `validateAffineSurface` を掛けられる）。
 */
export function affineRoadBands(options: AffineRoadOptions): AffineSurfaceCommand[] {
  const { generation, view } = options;
  const bandRows = Math.max(1, Math.round(options.bandRows ?? AFFINE_BAND_ROWS.detailed));
  const { camera, layout, screenWidth, screenHeight } = view;
  const halfWidth = screenWidth / 2;
  const patternV = patternPeriodMeters(layout) / layout.periodMeters;
  const patternMeters = patternPeriodMeters(layout);

  const bands: AffineSurfaceCommand[] = [];
  for (let top = camera.roadTopRow; top < screenHeight; top += bandRows) {
    const rows = Math.min(bandRows, screenHeight - top);
    // 帯の中心行が見ている距離。帯の中では 1 つの z で通す（uvStepY を 0 にするのと同じ意味で、
    // 実機の HDMA も 1 回の書き換えが次の書き換えまで効き続けた）
    const distance = view.distanceAtRow(top + rows / 2);
    const tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, view.headingDeltaAt(distance) * TILT_GAIN));
    const metersPerPixel = distance / camera.focal;

    const uStepX = (Math.cos(tilt) * metersPerPixel) / layout.spanMeters;
    const vStepXRaw = (Math.sin(tilt) * metersPerPixel) / layout.periodMeters;
    const vSpanLimit = MAX_V_SPAN / screenWidth;
    const vStepX = Math.max(-vSpanLimit, Math.min(vSpanLimit, vStepXRaw));

    // 行の V は画面中央で位相そのものになり、両端へ ±(W/2)·vStepX だけ振れる。
    // 位相は 1 周期の剰余でしか意味を持たないので、**中央がテクスチャの中央へ来るよう**
    // 1 周期単位でずらす。振れ幅を 0.25 に抑えてあるので clamp に当たらない
    const along = (view.originS + distance) / patternMeters;
    const phase = (along - Math.floor(along)) * patternV;
    const centered = phase + Math.round((0.5 - phase) / patternV) * patternV;
    const vOrigin = centered - halfWidth * vStepX;

    bands.push({
      id: `road-${generation}-${top}`,
      texture: layout.texture,
      screenRect: [0, top, screenWidth, rows],
      uvOrigin: [view.textureCenterAt(distance) - halfWidth * uStepX, vOrigin],
      uvStepX: [uStepX, vStepX],
      // 帯の中は同じ距離として扱うので、行方向の進みは持たない
      uvStepY: [0, 0],
      // repeat にすると、コーナーの先で U が範囲を出たときに二本目の道路が現れる
      wrap: 'clamp',
      generations: [generation],
    });
  }

  return bands;
}
