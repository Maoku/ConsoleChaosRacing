import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type TransformCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import { VEHICLE } from '../../sim/vehicle.js';
import type { DisplayCar } from './display-state.js';

/**
 * 車モデルの配置（実装計画 §3.4）。第3・第4世代が共用する。
 *
 * runtime GLB は material も image も持たない（変換で除去済み）。`MaterialCommand` に
 * `baseColorTexture` を積み忘れると fallback 柄で描かれ、例外にならないので気付きにくい。
 * `frame-contract.spec.ts` がそれを検出する。
 */

export interface CarModel {
  readonly asset: string;
  readonly texture: string;
  /**
   * 素のモデルの寸法 [m]。`public/assets/car-conversion.json` の bounds を写したもの。
   * **手で書いた値ではない**ので、モデルを差し替えたら `npm run prepare:cars` の
   * 出力から採り直す（`car-orientation.spec.ts` が JSON と突き合わせる）。
   */
  readonly bounds: {
    /** 前後（局所 X）*/ readonly length: number;
    /** 上下（局所 Y）*/ readonly height: number;
    /** 左右（局所 Z）*/ readonly width: number;
    /** 原点から車体の最下点まで [m]。路面に載せる持ち上げ量の元 */
    readonly bottom: number;
  };
}

/** 第1・第2世代はスプライトなのでモデルを持たない */
export const CAR_MODELS: GenerationVariant<CarModel | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    asset: 'assets/gen3/models/car.glb',
    texture: 'assets/gen3/textures/car_base_color.png',
    bounds: { length: 1.863012, height: 0.469346, width: 0.86497, bottom: 0.234673 },
  },
  PS2: {
    asset: 'assets/gen4/models/car.glb',
    texture: 'assets/gen4/textures/car_base_color.png',
    bounds: { length: 1.896733, height: 0.454939, width: 0.880626, bottom: 0.227470 },
  },
});

/**
 * 車輪（実装計画 フェーズ 12-7）。**第3・第4世代だけが持つ。**
 *
 * 実行時の `TransformCommand` は `rotationY` しか持たないので、車軸（局所 Z）まわりの
 * 回転は実行時には作れない。`tools/prepare-cars.mjs` が車体から切り離した車輪を
 * `phases` 段階の位相で焼き、フレームごとに `MeshCommand.asset` を差し替えて回す。
 *
 * 車体 GLB（`CarModel.asset`）にはもう車輪が入っていない。**必ず一緒に積む**こと。
 */
export interface CarWheels {
  /** 位相ぶんの GLB の頭。`carWheelAsset()` が位相番号を足す */
  readonly assetPrefix: string;
  /** 焼いてある位相の数 */
  readonly phases: number;
  /**
   * 車輪の半径 [モデル単位]。`car-conversion.json` の `runtime.wheels.radius` を
   * 写したもので、**手で書いた値ではない**（`car-conversion.spec.ts` が突き合わせる）。
   * 実寸にすると `radius × carModelScale()`。転がりの位相はこれで決まる。
   */
  readonly radius: number;
}

export const CAR_WHEELS: GenerationVariant<CarWheels | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    assetPrefix: 'assets/gen3/models/car_wheels_',
    phases: 8,
    radius: 0.12495077401399612,
  },
  PS2: {
    assetPrefix: 'assets/gen4/models/car_wheels_',
    phases: 8,
    radius: 0.1202395441941917,
  },
});

export function carWheelsFor(generation: GenerationId): CarWheels | null {
  return generationValue(CAR_WHEELS, generation);
}

export function carWheelAsset(generation: GenerationId, phase: number): string {
  const wheels = carWheelsFor(generation);
  if (!wheels) return '';
  const index = ((phase % wheels.phases) + wheels.phases) % wheels.phases;
  return `${wheels.assetPrefix}${index}.glb`;
}

/**
 * 転がりの位相。**車の走った距離だけで決まる**ので、シムに状態を足す必要が無い。
 *
 * 進んだ距離 s を実寸の車輪の外周で割ると回転数になる。位相を +θ で焼いてあり
 * （`rollWheel`）、局所前方が -X・上が +Y なので、θ が増えると車輪の上側が前へ回る
 * ＝ 前進の向きになる。
 *
 * 表示は世代の `animationHz` にラッチされた `s` を読むので、車輪の回り方も
 * その世代の更新レートで止まる（第3世代 30Hz・第4世代 60Hz）。
 */
export function carWheelPhase(generation: GenerationId, distance: number): number {
  const wheels = carWheelsFor(generation);
  if (!wheels) return 0;
  const circumference = 2 * Math.PI * wheels.radius * carModelScale(generation);
  const turns = distance / circumference;
  const phase = Math.floor(turns * wheels.phases) % wheels.phases;
  return phase < 0 ? phase + wheels.phases : phase;
}

/**
 * テールランプ（実装計画 フェーズ 12-7）。**第3・第4世代だけが持つ。**
 *
 * 元のテクスチャの赤は塗装テクスチャで無彩色に均されてしまう（`CAR_PAINT`）ので、
 * 灯火は**別のメッシュ**として持つ。`tools/build-car-lamps.mjs` が車体の後端から
 * 位置を実測して 2 枚の板を焼く。実行時は車体と同じ `carTransform()` で置き、
 * 明るさは `MeshCommand.color` の乗算だけで作る（トンネルの灯具と同じ作法）。
 */
export interface CarLamps {
  readonly asset: string;
}

export const CAR_LAMPS: GenerationVariant<CarLamps | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: { asset: 'assets/gen3/models/car_lamps.glb' },
  PS2: { asset: 'assets/gen4/models/car_lamps.glb' },
});

/**
 * ランプの板の形。**両世代で同じ規則**から焼く（値はモデル単位・半車幅に対する割合）。
 *
 * 後ろ向きの面（法線 X > 0.5）だけを後端の帯から拾い、その中で
 * `inner`〜`outer` の左右位置に入るものの中央の高さへ板を置く。第4世代の
 * テクスチャには赤い灯火が焼かれているが、位置がばらついていて（実測 23 三角形が
 * 車体の側面にも散っている）左右対称に採れないため、**両世代とも形状で決める**。
 */
export const CAR_LAMP_SHAPE = {
  /** 後端からこの割合（全長に対する）ぶんの帯を「後ろ姿」とみなす */
  band: 0.08,
  /** ランプの内端・外端。半車幅に対する割合 */
  inner: 0.25,
  outer: 0.58,
  /** 板の高さの半分 [モデル単位]。実寸では約 0.10 m */
  halfHeight: 0.022,
  /** 車体表面からの押し出し [モデル単位]。第4世代の深度バッファで Z ファイトしない量 */
  offset: 0.004,
  /**
   * 左右方向の分割数。**1 枚の平らな板では車体からはみ出す。**
   *
   * 車の後ろ姿は平らではなく、外側ほど前（-X）へ回り込んでいる。1 つの X に
   * 板を置くと外端が車体の輪郭の外へ飛び出し、路面の上に赤い板が浮く
   * （実機の画面で確認した）。列ごとに車体表面の X を測り直して、面に沿わせる。
   */
  columns: 4,
  /** 表面の X を測るときに見る左右の幅 [モデル単位]。低ポリでも頂点が拾える広さ */
  sample: 0.05,
} as const;

/** ランプの色。常時は弱く点り、ブレーキで強く点る（`mixColor` で混ぜる） */
export const CAR_LAMP_COLORS = { idle: '#4a0f08', brake: '#ff2a18' } as const;

export function carLampsFor(generation: GenerationId): CarLamps | null {
  return generationValue(CAR_LAMPS, generation);
}

/**
 * 灯火を積む価値があるか ＝ **カメラが車の後ろにいるか**。
 *
 * 板は後ろを向いた一枚面なので、前から見た車では GPU の背面カリングで 1 画素も
 * 描かれない。**絵は変わらないがドローコールだけが残る**ので、ここで落とす。
 * 第4世代の予算（§6.3・240 コール）は 8 台ぶんの車体・車輪・影で埋まっており、
 * 灯火まで無条件に積むと 1 フレームで 16 コールが増える。
 */
export function carLampsVisible(
  track: Track,
  car: DisplayCar,
  camera: readonly [number, number, number],
): boolean {
  const world = track.toWorld(car.s, car.lateral);
  const heading = carWorldHeading(track, car);
  // 前方 (cos H, 0, sin H) とカメラへ向かうベクトルの内積。負なら後ろから見ている
  return (
    Math.cos(heading) * (camera[0] - world[0]) + Math.sin(heading) * (camera[2] - world[2]) < 0
  );
}

/**
 * 素のモデルを実寸にする倍率（実装計画 11-5 / R-5 / D-11）。
 *
 * **素のモデルは 2D スプライトの車の 44 %（幅）しか無かった。** 同じ 1 つの
 * シミュレーションを描いているのに、世代で車の実寸が違っていたということで、
 * 「第3・第4世代の自機が小さい」原因はカメラではなくこれだった。
 * 12 m のコース幅に対し、素のままの 3D の車は 13.8 台が横に並べる大きさである。
 *
 * 値は**手で書かず、モデルの実測幅から導く**。車幅（`VEHICLE.CAR_WIDTH`）に
 * 合わせると全長は 4.22〜4.24 m になり、衝突判定の 4.2 m ともほぼ一致する。
 */
export function carModelScale(generation: GenerationId): number {
  const model = carModelFor(generation);
  return model ? VEHICLE.CAR_WIDTH / model.bounds.width : 1;
}

/**
 * 車体を路面へ載せるための持ち上げ [m]。**倍率と一緒に伸びる。**
 * 原点は車体の上下の中央にあるので、最下点ぶんだけ持ち上げれば接地する。
 */
export function carGroundOffset(generation: GenerationId): number {
  const model = carModelFor(generation);
  return model ? model.bounds.bottom * carModelScale(generation) : 0;
}

export function carModelFor(generation: GenerationId): CarModel | null {
  return generationValue(CAR_MODELS, generation);
}

/**
 * 車体色の作り方（実装計画 §3.4）。
 *
 * base color には赤いリバリーが焼き込まれているので、`MeshCommand.color` の乗算では
 * 8 台を見分けられない（黄を掛けても青が落ちて赤が残るだけ）。塗装を無彩色にした
 * テクスチャを 1 枚だけ焼き（`tools/build-car-paint.mjs`）、乗算をそのまま車体色にする。
 *
 * **色は実行時のパラメータ 1 つ**になるので、テクスチャは全車で 1 枚を共有でき、
 * マテリアルも 1 つで済む。色を変えるのに焼き直しは要らない。
 *
 * 引き換えに、窓のような無彩色のディテールも車体色に染まる。シェーダの合成は
 * `texture * uBaseColorFactor` の素直な乗算で、部位ごとにマスクを掛ける口が無いため
 * （`topColorTexture` は法線が上向きかで切り替わる地形用の仕組み）。元が暗いので
 * 「影のかかった窓」として読める範囲に収まっている。
 *
 * **タイヤだけは染まらない。** 12-7 で車輪を別メッシュに切り出したので、そちらは
 * 乗算する色を白のままにできる（`CAR_WHEELS`）。マテリアルもテクスチャも共有したまま、
 * 変わるのは `MeshCommand.color` 1 つである。
 */
export interface CarPaint {
  /** 塗装テクスチャの元。`public/` からの相対 */
  readonly source: string;
  /** 出力する一辺 [px]。元より小さいときは整数倍のボックス縮小 */
  readonly size: number;
  /** 出力先。これを manifest とマテリアルが参照する */
  readonly texture: string;
}

export const CAR_PAINT: GenerationVariant<CarPaint | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    source: 'assets/gen3/textures/car_base_color.png',
    size: 256,
    texture: 'assets/gen3/textures/car_paint.png',
  },
  PS2: {
    source: 'assets/gen4/textures/car_base_color.png',
    size: 512,
    texture: 'assets/gen4/textures/car_paint.png',
  },
});

/** 実際に貼るテクスチャ。塗装テクスチャがあればそれ、無ければ素の base color */
export function carTextureFor(generation: GenerationId): string {
  return generationValue(CAR_PAINT, generation)?.texture ?? carModelFor(generation)?.texture ?? '';
}

/**
 * 車 GLB の前方軸は **-X**（`data/README.md` に記録・`car-conversion.json` に保存）。
 *
 * `rotationY(θ)` は局所ベクトル (x, 0, z) を (x·cosθ + z·sinθ, 0, −x·sinθ + z·cosθ) へ写す。
 * 局所前方 (−1, 0, 0) は (−cosθ, 0, sinθ) になるので、これをワールドの進行方向
 * (cos H, 0, sin H) に合わせると **θ = π − H** が出る。
 *
 * 実装時に 1 回だけ実測して定数化する、と決めていた符号がこれ（§8 リスク表）。
 * `car-orientation.spec.ts` が固定する。
 */
export const CAR_YAW_OFFSET = Math.PI;
export const CAR_YAW_SIGN = -1;

export function carRotationY(worldHeading: number): number {
  return CAR_YAW_OFFSET + CAR_YAW_SIGN * worldHeading;
}

/** 進行方向（コース接線に車のヨー角を足したもの）[rad] */
export function carWorldHeading(track: Track, car: DisplayCar): number {
  return track.sampleAt(car.s).heading + car.yaw;
}

/**
 * 車 1 台ぶんの配置。`rotationY` 以外の回転は指定できないので、車体の傾きは出せない。
 * 拡大は 3 軸とも同じ倍率 — 車の形は変えず、実寸へ合わせるだけである。
 */
export function carTransform(
  track: Track,
  car: DisplayCar,
  generation: GenerationId,
): TransformCommand {
  const world = track.toWorld(car.s, car.lateral);
  const scale = carModelScale(generation);
  return {
    position: [world[0], world[1] + carGroundOffset(generation), world[2]],
    rotationY: carRotationY(carWorldHeading(track, car)),
    scale: [scale, scale, scale],
  };
}
