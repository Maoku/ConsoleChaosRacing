import {
  defineGenerationVariant,
  generationValue,
  type CameraCommand,
  type GenerationId,
  type GenerationVariant,
} from '@console-chaos/engine';

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

/**
 * 視点（実装計画 8-5）。
 *
 * 擬似3D の 2 世代に追走以外が無いのは、`RoadView`（§3.1）が追走カメラの幾何
 * そのものだからである。**車内視点へ組み替えることはしない** — 投影の作りが
 * 変わってしまい、「同じシミュレーションを世代の作法で描く」という構造が崩れる。
 */
export type CameraViewId = 'chase' | 'windshield' | 'cockpit';

/**
 * 世代ごとに選べる視点。**内装があるのは第4世代だけ**で、
 * 640×448・linear フィルタ・GS alpha が揃って初めて内装が絵として成立する
 * （320×240 では帯にしか見えない）。これ自体が世代差の表現になる。
 */
export const CAMERA_VIEWS: GenerationVariant<readonly CameraViewId[]> = defineGenerationVariant({
  FC: ['chase'],
  SFC: ['chase'],
  PS1: ['chase', 'windshield'],
  PS2: ['chase', 'windshield', 'cockpit'],
});

/** 車内視点の幾何 [m]。目線は自機の少し前・路面から 1.05 m */
const WINDSHIELD = {
  FORWARD: 0.6,
  EYE_HEIGHT: 1.05,
  LOOK_AHEAD: 30,
  TARGET_HEIGHT: 1.0,
} as const;

export function cameraViewsFor(generation: GenerationId): readonly CameraViewId[] {
  return generationValue(CAMERA_VIEWS, generation);
}

/**
 * その世代で使える視点へ落とす。世代を切り替えたとき、
 * 移った先に無い視点なら `chase` へ戻す（切替演出中に 2 世代を積むフレームでも、
 * 各ビューは自分の世代のリストだけを見る）。
 */
export function resolveCameraView(
  generation: GenerationId,
  view: CameraViewId,
): CameraViewId {
  return cameraViewsFor(generation).includes(view) ? view : 'chase';
}

/** 次の視点。視点が 1 つしか無い世代では押しても何も起きない */
export function cycleCameraView(generation: GenerationId, view: CameraViewId): CameraViewId {
  const views = cameraViewsFor(generation);
  const index = views.indexOf(resolveCameraView(generation, view));
  return views[(index + 1) % views.length]!;
}

/** 車内からの視点では自機のメッシュを積まない（第4世代では影専用メッシュも） */
export function hidesPlayerCar(view: CameraViewId): boolean {
  return view !== 'chase';
}

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

/**
 * 車内からの視点（`windshield` / `cockpit`）。
 *
 * 目線は自機のすぐ前・路面から 1.05 m で、注視点は 30 m 先。追走視点より
 * 目線が低く前が遠いぶん、同じ速度でも路面の流れが速く見える。
 * 内装（`cockpit`）はカメラを変えず、スクリーン空間スプライトを被せるだけなので、
 * 幾何はこの 1 つで足りる。
 */
export function windshieldCamera({ track, car }: FollowCameraOptions): CameraCommand {
  const speedRatio = Math.min(1, Math.max(0, car.speed / VEHICLE.MAX_SPEED));
  const eye = track.toWorld(car.s + WINDSHIELD.FORWARD, car.lateral);
  const focus = track.toWorld(car.s + WINDSHIELD.LOOK_AHEAD, car.lateral * 0.5);

  return {
    projection: 'perspective',
    position: [eye[0], eye[1] + WINDSHIELD.EYE_HEIGHT, eye[2]],
    target: [focus[0], focus[1] + WINDSHIELD.TARGET_HEIGHT, focus[2]],
    zoom: WINDSHIELD.LOOK_AHEAD,
    fovDegrees: CAMERA.FOV_MIN + (CAMERA.FOV_MAX - CAMERA.FOV_MIN) * speedRatio,
  };
}

export interface ViewCameraOptions extends FollowCameraOptions {
  readonly view: CameraViewId;
}

/** 視点 → カメラ。`view` はビューが `resolveCameraView()` 済みの値を渡す */
export function viewCamera({ track, car, view }: ViewCameraOptions): CameraCommand {
  return view === 'chase' ? followCamera({ track, car }) : windshieldCamera({ track, car });
}
