import type { AffineSurfaceCommand, GenerationId } from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import {
  SFC_ROAD_MAP,
  roadMapProjection,
  type RoadMapLayout,
} from './road-map.js';
import type { RoadView } from './projection.js';

/**
 * 走査線ごとのアフィン変換による擬似3D（実装計画 §3.3）。第2世代の路面はこれ 1 本で出る。
 *
 * アフィン変換は 1 枚では透視にならない。実機（Mode 7）は HDMA で**走査線ごとに
 * パラメータを書き換えて**透視を作っていたので、ここでも同じ構造にする —
 * `AffineSurfaceCommand` を 1 行につき 1 枚積む。
 *
 * ## 引くのは「コース全体のトップダウン図」
 *
 * 初版は直線路 1 本の帯テクスチャを引き、コーナーは走査線ごとに U をずらして
 * **それらしく見せていた**。真上から見たコースの形はどこにも無いので、
 * ヘアピンでも視界は上限を掛けた演出ぶんしか回らず、「コーナーの先の路面が見える」
 * という Mode 7 のいちばんの特徴が出なかった。
 *
 * いまはコースマップ（`road-map.ts` / `build-road-map.mjs`）を引く。UV が
 * **ワールド XZ の写像そのもの**になるので、回転は演出ではなく投影の帰結として出る。
 * 傾きの上限も V の位相合わせも要らなくなり、この関数から消えた。
 *
 * ## エンジンが読む値
 *
 * シェーダは矩形の左上を原点とする局所座標 `local` から
 *
 *     uv = uvOrigin + uvStepX · local.x + uvStepY · local.y
 *
 * を引く（`affineUvAt` が同じ式の CPU 参照）。`uvStepX` は **Vec2** であり、
 * 「画面を右へ 1 px 進んだときの U と V の進み」を別々に指定できる。
 * マップは軸がワールド X / Z に固定されているので、**視線が斜めを向いているぶんが
 * そのまま両成分に乗る** — これがコーナーで視界が回る仕組みになる。
 *
 * ## 1 行ぶんの導出
 *
 * カメラ位置 C・前方 F・右 R（いずれもワールド XZ）、行が見ている距離 z、焦点距離 f として、
 * 画面 x 列が見ているワールド上の点は
 *
 *     P(x) = C + z·F + (x - W/2)·(z/f)·R
 *
 * これをマップの UV へ落とすだけでよい。画面を右へ 1 px 進む量 `(z/f)·R` を
 * texel へ直したものが `uvStepX`、`P(0)` の UV が `uvOrigin` になる。
 * **第1世代のラスターと同じ `RoadView` から引いている** — 表現手法が違うだけで投影は 1 つ。
 *
 * ## 遠クリップと wrap
 *
 * 行の距離は `map.farClip` で止める。下り坂ではカメラと路面の高さの差が開いて
 * 最上行が 358 m 先まで見てしまい、そこまで窓（＝実機の Mode 7 面）に入れると
 * 密度が落ちる（`road-map.ts` の「密度の決まり方」）。止めた先の行は 4 枚目の
 * フォグ帯より奥＝ 94% が霞んでおり、地面の絵は 6% しか効かない。
 *
 * `wrap` は `clamp`。マップの外周は単色で焼いてあるので、コースの外へ出た UV は
 * その色で埋まる — 実機の「マップ外はタイル 0 を敷く」設定と同じ挙動になる。
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

export interface AffineRoadOptions {
  readonly generation: GenerationId;
  readonly view: RoadView;
  /** 視点のワールド座標を引くためのコース。マップの原点もここの `bounds` から決まる */
  readonly track: Track;
  /** 引くマップ。省略すると第2世代のもの */
  readonly map?: RoadMapLayout;
  /** 1 枚のサーフェスが受け持つ行数。`affineBandRows()` で決める */
  readonly bandRows?: number;
}

/**
 * 路面帯をアフィンサーフェスの列に変換する。フレームへは積まない
 * （テストが純関数として `validateAffineSurface` を掛けられる）。
 */
export function affineRoadBands(options: AffineRoadOptions): AffineSurfaceCommand[] {
  const { generation, view, track } = options;
  const map = options.map ?? SFC_ROAD_MAP;
  const projection = roadMapProjection(track.bounds, map);
  const bandRows = Math.max(1, Math.round(options.bandRows ?? AFFINE_BAND_ROWS.detailed));
  const { camera, screenWidth, screenHeight } = view;
  const halfWidth = screenWidth / 2;

  // 視点のワールド位置と向き。カメラはコースの接線を前方とする（`projection.ts`）
  const origin = track.sampleAt(view.originS);
  const eye = track.toWorld(view.originS, view.originLateral);
  const [forwardX, forwardZ] = origin.tangent;
  const [rightX, rightZ] = origin.right;

  // 1 m あたりの UV。マップは等方なので、texel 数だけが軸ごとに違う
  const uPerMeter = map.texelsPerMeter / projection.width;
  const vPerMeter = map.texelsPerMeter / projection.height;

  const bands: AffineSurfaceCommand[] = [];
  for (let top = camera.roadTopRow; top < screenHeight; top += bandRows) {
    const rows = Math.min(bandRows, screenHeight - top);
    // 帯の中では 1 つの距離で通す（uvStepY を 0 にするのと同じ意味で、
    // 実機の HDMA も 1 回の書き換えが次の書き換えまで効き続けた）
    const distance = Math.min(map.farClip, view.distanceAtRow(top + rows / 2));
    const metersPerPixel = distance / camera.focal;

    // 画面を右へ 1 px 進むと、ワールドでは right へ metersPerPixel だけ動く
    const uStepX = rightX * metersPerPixel * uPerMeter;
    const vStepX = rightZ * metersPerPixel * vPerMeter;

    // 画面左端（local.x = 0）が見ているワールド上の点
    const worldX = eye[0] + forwardX * distance - rightX * halfWidth * metersPerPixel;
    const worldZ = eye[2] + forwardZ * distance - rightZ * halfWidth * metersPerPixel;

    bands.push({
      id: `road-${generation}-${top}`,
      texture: map.texture,
      screenRect: [0, top, screenWidth, rows],
      uvOrigin: [
        (worldX - projection.originX) * uPerMeter,
        (worldZ - projection.originZ) * vPerMeter,
      ],
      uvStepX: [uStepX, vStepX],
      // 帯の中は同じ距離として扱うので、行方向の進みは持たない
      uvStepY: [0, 0],
      // マップの外周は単色。clamp がコースの外へその色を伸ばす
      wrap: 'clamp',
      generations: [generation],
    });
  }

  return bands;
}
