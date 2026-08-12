import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type TransformCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
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
}

/** 第1・第2世代はスプライトなのでモデルを持たない */
export const CAR_MODELS: GenerationVariant<CarModel | null> = defineGenerationVariant({
  FC: null,
  SFC: null,
  PS1: {
    asset: 'assets/gen3/models/car.glb',
    texture: 'assets/gen3/textures/car_base_color.png',
  },
  PS2: {
    asset: 'assets/gen4/models/car.glb',
    texture: 'assets/gen4/textures/car_base_color.png',
  },
});

export function carModelFor(generation: GenerationId): CarModel | null {
  return generationValue(CAR_MODELS, generation);
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

/** 車体の原点は上下の中央にあるので、路面に載せるぶん持ち上げる [m] */
export const CAR_GROUND_OFFSET = 0.25;

/** 進行方向（コース接線に車のヨー角を足したもの）[rad] */
export function carWorldHeading(track: Track, car: DisplayCar): number {
  return track.sampleAt(car.s).heading + car.yaw;
}

/** 車 1 台ぶんの配置。`rotationY` 以外の回転は指定できないので、車体の傾きは出せない */
export function carTransform(track: Track, car: DisplayCar): TransformCommand {
  const world = track.toWorld(car.s, car.lateral);
  return {
    position: [world[0], world[1] + CAR_GROUND_OFFSET, world[2]],
    rotationY: carRotationY(carWorldHeading(track, car)),
  };
}
