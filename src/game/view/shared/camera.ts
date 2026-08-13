import type { CameraCommand } from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import { VEHICLE } from '../../sim/vehicle.js';
import type { DisplayCar } from './display-state.js';

/**
 * 3D 追従カメラ（実装計画 §3.4）。第3・第4世代が共用する。
 *
 * **トラック空間の上で組む。** 車のヨー角ではなくコースの接線を基準にするので、
 * 車が滑っても視界が揺れず、状態を持たない純関数のままにできる
 * （§2.1: ビューは `RaceState` → `RenderFrame` の純関数）。
 *
 * 見た目の更新レートの量子化は `DisplayLatch` が済ませてある。ここへ渡ってくる
 * `car` は既にその世代のレートで止まっているので、カメラも同じレートで動く。
 */

/**
 * 追走カメラの幾何（実装計画 8-4 で車体へ寄せた）。
 *
 * 当初の 6.5 m / 2.2 m は引きすぎで、車が画面の 1/6 ほどしか占めていなかった。
 * 第4世代の署名的表現である映り込み（§6.1 基準 1）も、第3世代の頂点の揺れ
 * （基準 2）も、車が小さいままでは読み取れない。
 *
 * 画角（60°→72°）は据え置く。**近づけたうえに広げると樽型に見える**。
 * フォグ密度・遠景の帯・セクターのカリング半径も変えない — 第4世代の水平線の行は
 * カメラのピッチから毎フレーム求めているので自動で追従する（§3.4）。
 */
export const CAMERA = {
  /** 自機の後方距離 [m]。車体を画面の主役にする */
  BEHIND: 4.4,
  /** 高さ [m]。見下ろしを浅くして速度感を出す（路面高からの相対） */
  HEIGHT: 1.55,
  /** 注視点の前方距離 [m]。遠いままだと車が画面下端へ落ちる */
  LOOK_AHEAD: 9,
  /** 注視点の高さ [m] */
  TARGET_HEIGHT: 0.75,
  /** 停止時の画角 [deg] */
  FOV_MIN: 60,
  /** 最高速時の画角 [deg] */
  FOV_MAX: 72,
  /** 最高速時に後方へ伸びる距離 [m]。最高速でも 5.5 m に収める */
  BEHIND_STRETCH: 1.1,
  /** 横位置の追従率。1 なら車の真後ろ、0 ならコース中心の後ろ */
  LATERAL_FOLLOW: 0.55,
  /** 注視点の横位置の追従率 */
  TARGET_LATERAL_FOLLOW: 0.3,
} as const;

export interface FollowCameraOptions {
  readonly track: Track;
  readonly car: DisplayCar;
}

/**
 * 自機の後方から追うカメラ。
 * 速度が上がるほど画角が広がり、カメラが少し引く。これだけで速度感が変わる。
 */
export function followCamera({ track, car }: FollowCameraOptions): CameraCommand {
  const speedRatio = Math.min(1, Math.max(0, car.speed / VEHICLE.MAX_SPEED));
  const behind = CAMERA.BEHIND + CAMERA.BEHIND_STRETCH * speedRatio;

  const eye = track.toWorld(car.s - behind, car.lateral * CAMERA.LATERAL_FOLLOW);
  const focus = track.toWorld(
    car.s + CAMERA.LOOK_AHEAD,
    car.lateral * CAMERA.TARGET_LATERAL_FOLLOW,
  );

  return {
    projection: 'perspective',
    position: [eye[0], eye[1] + CAMERA.HEIGHT, eye[2]],
    target: [focus[0], focus[1] + CAMERA.TARGET_HEIGHT, focus[2]],
    // ortho 世代でしか使われないが、コマンドの必須項目なので埋めておく
    zoom: CAMERA.LOOK_AHEAD,
    fovDegrees: CAMERA.FOV_MIN + (CAMERA.FOV_MAX - CAMERA.FOV_MIN) * speedRatio,
  };
}
