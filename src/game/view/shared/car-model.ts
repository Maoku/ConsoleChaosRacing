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
 * 引き換えに、タイヤ・窓といった無彩色のディテールも車体色に染まる。シェーダの合成は
 * `texture * uBaseColorFactor` の素直な乗算で、部位ごとにマスクを掛ける口が無いため
 * （`topColorTexture` は法線が上向きかで切り替わる地形用の仕組み）。
 * 元が暗いので「影のかかったホイール」として読める範囲に収まっている。
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
