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
 * 追走カメラの幾何（実装計画 8-4 → 11-5 で引き直した）。
 *
 * 8-4 で「車が画面の 1/6 しか占めていない」として 6.5 m → 3.2 m まで寄せたが、
 * **小さかった原因はカメラではなくモデルの寸法だった**（素のモデルは 2D の車の
 * 44 % しかなかった。`car-model.ts` の `carModelScale`）。車を実寸にすると
 * 3.2 m のままでは車体が画面幅の 71 % を占め、30 m 先の路面が屋根の 10 px 上にしか
 * 残らない。そこで**モデルを実寸にしてカメラを引き直す**（D-11）。
 *
 * 値は投影で測って決めた（速度 40 m/s・PS1・320×240 の実測）。
 *
 * | BEHIND | HEIGHT | 車幅 | 屋根の行 / 240 | 30 m 先の路面の行 |
 * | --- | --- | --- | --- | --- |
 * | 3.2 / 1.25（8-4・素のモデル） | | 18 % | 161 | 117 |
 * | 4.5 | 1.6 | 38.3 % | 137 | 126 |
 * | **5.0** | **1.6** | **33.0 %** | **136** | **125** |
 * | 5.5 | 1.6 | 28.6 % | 135 | 125 |
 * | 5.0 | 1.8 | 32.5 % | 128 | 127 |
 *
 * 5.0 m / 1.6 m で車体は画面幅の 33 %（今までの 1.8 倍）になり、30 m 先の路面は
 * 屋根より 11 行うえに残る。速度で 0.9 m 伸びるので、40 m/s での実効距離は 5.46 m。
 * **高さを 1.25 m のままにすると屋根の行と 30 m 先の路面の行がほぼ重なり、
 * 車体が前方の視界を塞ぐ**（上の表の 1.8 m がその境目）— 実寸化には目線を上げるのが
 * 必ず要る。
 *
 * 画角（60°→72°）は据え置く。**近づけたうえに広げると樽型に見える**。
 * フォグ密度・遠景の帯・セクターのカリング半径も変えない — 第4世代の水平線の行は
 * カメラのピッチから毎フレーム求めているので自動で追従する（§3.4）。
 */
export const CAMERA = {
  /** 自機の後方距離 [m]。車体を画面の主役にする */
  BEHIND: 5,
  /** 高さ [m]。実寸の車体で前方の視界を確保する（路面高からの相対） */
  HEIGHT: 1.6,
  /** 注視点の前方距離 [m]。遠いままだと車が画面下端へ落ちる */
  LOOK_AHEAD: 7,
  /** 注視点の高さ [m] */
  TARGET_HEIGHT: 0.7,
  /** 停止時の画角 [deg] */
  FOV_MIN: 60,
  /** 最高速時の画角 [deg] */
  FOV_MAX: 72,
  /** 最高速時に後方へ伸びる距離 [m]。最高速でも 5.9 m に収める */
  BEHIND_STRETCH: 0.9,
  /** 横位置の追従率。1 なら車の真後ろ、0 ならコース中心の後ろ */
  LATERAL_FOLLOW: 0.55,
  /** 注視点の横位置の追従率 */
  TARGET_LATERAL_FOLLOW: 0.3,
  /**
   * カメラが自機の横位置から**遅れてよい上限** [m]。
   *
   * 追従率だけで作ると、遅れ（`lateral × (1 − 追従率)`）が横位置に比例して
   * 際限なく伸びる。コースアウトして路面から 15 m 出ると遅れも 6.8 m になり、
   * **自機が画面の外へ流れて見えなくなる**。上限で切ると、どれだけ外へ出ても
   * 自機はカメラの正面から `LATERAL_LAG_MAX` メートル以内に留まる。
   *
   * 値は**ミニマップの矩形から決めた**。上限に張り付いたときの自機は画面の横 63 %
   * の位置に来る（実測）。ミニマップの左端は第3・第4世代とも画面の 68 % なので、
   * 車体の幅を含めても**ミニマップの下へ潜らない**。
   * 上限に当たり始めるのは |lateral| > 2.7 m からで、走行ラインの振れ幅の中では
   * カメラがコーナーの内側へ膨らむ見え方がそのまま残る。
   */
  LATERAL_LAG_MAX: 1.2,
  /** 注視点の遅れの上限 [m]。カメラより小さく採り、視線を自機へ寄せる */
  TARGET_LAG_MAX: 0.6,
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
 * カメラ（または注視点）の横位置 [m]。
 *
 * 追従率のぶんだけ自機から遅れるが、**遅れには上限がある**。
 * 上限が無いと、コースアウトして横へ 15 m 出たときに遅れも 6.8 m に伸び、
 * 自機が画面の外へ流れて見えなくなる（8-4 の追記）。
 *
 * 路面の内側では上限に当たらないので、走行中の見え方は追従率だけのときと同じ。
 */
export function followLateral(lateral: number, follow: number, maxLag: number): number {
  const lag = lateral * (1 - follow);
  return lateral - Math.max(-maxLag, Math.min(maxLag, lag));
}

/**
 * 自機の後方から追うカメラ。
 * 速度が上がるほど画角が広がり、カメラが少し引く。これだけで速度感が変わる。
 */
export function followCamera({ track, car }: FollowCameraOptions): CameraCommand {
  const speedRatio = Math.min(1, Math.max(0, car.speed / VEHICLE.MAX_SPEED));
  const behind = CAMERA.BEHIND + CAMERA.BEHIND_STRETCH * speedRatio;

  const eye = track.toWorld(
    car.s - behind,
    followLateral(car.lateral, CAMERA.LATERAL_FOLLOW, CAMERA.LATERAL_LAG_MAX),
  );
  const focus = track.toWorld(
    car.s + CAMERA.LOOK_AHEAD,
    followLateral(car.lateral, CAMERA.TARGET_LATERAL_FOLLOW, CAMERA.TARGET_LAG_MAX),
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
