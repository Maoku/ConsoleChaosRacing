import type { HardwareGenerationProfile } from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import type { DisplayCar } from './display-state.js';
import { ROAD_SURFACE, roadFraction, type RoadSurfaceLayout } from './road-surface.js';

/**
 * 擬似3D投影（実装計画 §3.1）。第1世代（ラスター）と第2世代（アフィン）が共用する。
 *
 * カメラは自機の真後ろ・高さ `cameraHeight` に置き、**コースの接線を前方**とする。
 * 車のヨー角では回さない。第3・第4世代の `camera.ts` と同じ方針で、
 * 車が滑っても視界が揺れず、ビューを状態を持たない純関数のままにできる。
 *
 * ```
 * 画面行 y（地平線より下）が見ている前方距離:  z(y) = (camY - Δy(z)) * focal / (y - yH)
 * その距離での 1 m あたりの画面幅:              focal / z
 * 中心線の横ずれ（自機基準）:                   off(z) = (P(s0+z) - P(s0))·right(s0) - lateral0
 * 路面中心の画面 X:                             cx(z) = W/2 + off(z) * focal / z
 * ```
 *
 * `off(z)` は曲率の積分近似ではなく `TrackSample` の実座標から引く。
 * **4 世代が同じ `track.toWorld()` の上に乗る**という不変条件（§2.2）が
 * 擬似3Dの側でもそのまま成り立つ。
 *
 * 標高差 `Δy(z)` は行ごとの距離に効かせる（地平線のうねりとして出る）。
 * `z` が `Δy` に依存するので閉じた式にはならないが、視界 100 m での標高差は
 * 高々 1 m 程度なので不動点反復が 2 回で収まる。
 */

export interface PseudoCamera {
  /** 焦点距離 [px]。画角は 2·atan(W/2 / focal) */
  readonly focal: number;
  /** カメラ高さ [m] */
  readonly cameraHeight: number;
  /** 地平線（消失点）の画面行 */
  readonly horizonRow: number;
  /** 路面帯の上端行。ここから画面下端までがラスター／アフィンの矩形になる */
  readonly roadTopRow: number;
  /**
   * 自機の後方にカメラを引く距離 [m]。
   *
   * **0 にしてはいけない。** カメラを自機の位置に置くと自機までの距離が 0 になり、
   * 自機だけ投影の外側で場当たりに配置することになる。後ろへ引いておけば
   * 自機もライバルもまったく同じ式で置け、隣に並んだ 2 台が同じ大きさで描かれる。
   */
  readonly behind: number;
}

/**
 * 第1世代の投影パラメータ。
 *
 * `spanMeters = 84 m` と `width ∈ [0.09, 1]` から、順に次のように決まる。
 *
 * ```
 * cameraHeight = width下限 · spanMeters · (画面下端 - 地平線) / 画面幅
 *              = 0.090 × 84 × 135 / 256 ≒ 4.0 m
 * 最遠距離     = spanMeters · focal / 画面幅 = 84 × 300 / 256 ≒ 98 m
 * 最近距離     = cameraHeight · focal / (画面下端 - 地平線) = 4 × 300 / 135 ≒ 8.9 m
 * ```
 *
 * カメラが 4 m と高いのは意図的で、これが「路面が奥で細くなる」量を決めている。
 * 目線を下げると路面が太いまま地平線に届いてしまう。
 *
 * `behind` は自機の接地線が画面下端の少し上（行 214）へ来る値を採った。
 * `horizonRow + cameraHeight · focal / behind = 88 + 1200 / 9.5 ≒ 214`。
 */
export const FC_CAMERA: PseudoCamera = {
  focal: 300,
  cameraHeight: 4,
  horizonRow: 88,
  roadTopRow: 101,
  behind: 9.5,
};

export interface RoadViewOptions {
  readonly profile: HardwareGenerationProfile;
  readonly camera: PseudoCamera;
  readonly track: Track;
  /** 視点になる車（表示レートへ量子化済み） */
  readonly car: DisplayCar;
  readonly layout?: RoadSurfaceLayout;
}

export interface RoadView {
  readonly camera: PseudoCamera;
  readonly layout: RoadSurfaceLayout;
  readonly screenWidth: number;
  readonly screenHeight: number;
  /** 視点の弧長 */
  readonly originS: number;
  /** 視点の横位置 [m] */
  readonly originLateral: number;
  /** `width ≤ 1` を守れる最遠距離 [m] */
  readonly maxDistance: number;

  /** 画面行 → 前方距離 [m]。標高差を織り込む */
  distanceAtRow(row: number): number;
  /** 前方距離 → 画面行（`distanceAtRow` の逆） */
  rowAtDistance(distance: number): number;
  /** 距離 z の中心線の横ずれ [m]（自機基準・右が正） */
  lateralOffsetAt(distance: number): number;
  /** 距離 z の路面中心の画面 X [px] */
  centerXAt(distance: number): number;
  /** 距離 z の 1 m あたりの画面幅 [px] */
  scaleAt(distance: number): number;
  /** 距離 z の走査線 `width`（サーフェスの U 幅）。(0, 1] に収めてある */
  sourceWidthAt(distance: number): number;
  /** 距離 z の走査線 `center`（サーフェスの U 中心）。[0, 1) に収めてある */
  sourceCenterAt(distance: number): number;
  /** 距離 z の V（進行方向の位相）。[0, 1) */
  sourceVAt(distance: number): number;
}

/** 距離 z の路面と視点の標高差 [m]。上りが正 */
function elevationDelta(track: Track, originY: number, s: number): number {
  return track.sampleAt(s).position[1] - originY;
}

export function createRoadView(options: RoadViewOptions): RoadView {
  const { profile, camera, track, car } = options;
  const layout = options.layout ?? ROAD_SURFACE;
  const screenWidth = profile.video.internalWidth;
  const screenHeight = profile.video.internalHeight;

  // カメラは自機の後方。横位置は自機に合わせるので、直線では自機が画面中央に来る
  const originS = track.wrapS(car.s - camera.behind);
  const originLateral = car.lateral;
  const origin = track.sampleAt(originS);
  const originY = track.toWorld(originS, originLateral)[1];

  const maxDistance = (layout.spanMeters * camera.focal) / screenWidth;
  /** 走査線 `width` の下限。0 に近づくほど 8bit 量子化の刻みが目立つ */
  const minSourceWidth = 0.02;

  /** カメラから見た路面の高さの差。分母が 0 以下にならないよう下限を置く */
  function effectiveHeight(distance: number): number {
    return Math.max(0.35, camera.cameraHeight - elevationDelta(track, originY, originS + distance));
  }

  function rowAtDistance(distance: number): number {
    const safe = Math.max(0.5, distance);
    return camera.horizonRow + (effectiveHeight(safe) * camera.focal) / safe;
  }

  function distanceAtRow(row: number): number {
    const below = row - camera.horizonRow;
    if (below <= 0) return Number.POSITIVE_INFINITY;
    // 不動点反復。Δy は視界の中で高々 1 m 程度なので 2 回で十分収まる
    let distance = (camera.cameraHeight * camera.focal) / below;
    for (let iteration = 0; iteration < 2; iteration++) {
      distance = (effectiveHeight(distance) * camera.focal) / below;
    }
    return distance;
  }

  function lateralOffsetAt(distance: number): number {
    const ahead = track.sampleAt(originS + distance);
    const dx = ahead.position[0] - origin.position[0];
    const dz = ahead.position[2] - origin.position[2];
    return dx * origin.right[0] + dz * origin.right[1] - originLateral;
  }

  function scaleAt(distance: number): number {
    return camera.focal / Math.max(0.5, distance);
  }

  function centerXAt(distance: number): number {
    return screenWidth / 2 + lateralOffsetAt(distance) * scaleAt(distance);
  }

  function sourceWidthAt(distance: number): number {
    const raw = (screenWidth * distance) / (layout.spanMeters * camera.focal);
    return Math.min(1, Math.max(minSourceWidth, raw));
  }

  function sourceCenterAt(distance: number): number {
    // center は 8bit へ量子化されるときに fract されるため、[0, 1) を出ると
    // 路面が反対側から巻き戻って現れる。路面はテクスチャ中央の狭い帯なので、
    // 端で止めれば「コーナーの先で路面が画面外へ流れる」見え方はそのまま残る
    const raw = 0.5 - lateralOffsetAt(distance) / layout.spanMeters;
    return Math.min(0.999, Math.max(0, raw));
  }

  function sourceVAt(distance: number): number {
    const along = (originS + distance) / layout.periodMeters;
    return along - Math.floor(along);
  }

  return {
    camera,
    layout,
    screenWidth,
    screenHeight,
    originS,
    originLateral,
    maxDistance,
    distanceAtRow,
    rowAtDistance,
    lateralOffsetAt,
    centerXAt,
    scaleAt,
    sourceWidthAt,
    sourceCenterAt,
    sourceVAt,
  };
}

/**
 * 路面帯の上端行が妥当か（走査線 `width` が 1 を超えないか）を確かめるための値。
 * `raster-scanline.spec.ts` がこれを使って、設計値と実装値の食い違いを検出する。
 */
export function roadTopRowFor(
  profile: HardwareGenerationProfile,
  camera: PseudoCamera,
  layout: RoadSurfaceLayout = ROAD_SURFACE,
): number {
  const maxDistance = (layout.spanMeters * camera.focal) / profile.video.internalWidth;
  return Math.ceil(camera.horizonRow + (camera.cameraHeight * camera.focal) / maxDistance);
}

/** 最遠で路面が画面に占める幅 [px]。設計の意図（細く収束すること）を数値で確認できる */
export function farRoadWidthPx(
  profile: HardwareGenerationProfile,
  layout: RoadSurfaceLayout = ROAD_SURFACE,
): number {
  return roadFraction(layout) * profile.video.internalWidth;
}
