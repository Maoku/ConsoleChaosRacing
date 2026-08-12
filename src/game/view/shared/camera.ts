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

export const CAMERA = {
  /** 自機の後方距離 [m] */
  BEHIND: 6.5,
  /** 高さ [m] */
  HEIGHT: 2.2,
  /** 注視点の前方距離 [m] */
  LOOK_AHEAD: 12,
  /** 注視点の高さ [m] */
  TARGET_HEIGHT: 0.9,
  /** 停止時の画角 [deg] */
  FOV_MIN: 60,
  /** 最高速時の画角 [deg] */
  FOV_MAX: 72,
  /** 最高速時に後方へ伸びる距離 [m] */
  BEHIND_STRETCH: 1.6,
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
