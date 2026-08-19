import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { TRACK } from '../src/game/sim/track.js';
import {
  CAR_YAW_OFFSET,
  CAR_YAW_SIGN,
  carRotationY,
  carTransform,
  carWorldHeading,
} from '../src/game/view/shared/car-model.js';
import { raceAfter } from './support/frame.js';

/**
 * 車 GLB の前方軸の符号を固定する（実装計画 §8 リスク表: 「1 回だけ実測して定数化」）。
 *
 * `rotationY(θ)` の実装（gl-matrix の列優先 mat4）は局所ベクトル (x, y, z) を
 * (x·cosθ + z·sinθ, y, −x·sinθ + z·cosθ) へ写す。この関数をここで再現し、
 * 局所前方 −X がワールドの進行方向へ一致することを確かめる。
 */
function rotateY(vector: readonly [number, number, number], radians: number) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [
    vector[0] * cos + vector[2] * sin,
    vector[1],
    -vector[0] * sin + vector[2] * cos,
  ] as const;
}

/** 車 GLB の局所前方。`data/README.md` と `car-conversion.json` に記録されている */
const LOCAL_FORWARD = [-1, 0, 0] as const;

describe('車モデルの向き', () => {
  it('変換記録が前方軸 -X を主張している', () => {
    const record = JSON.parse(
      readFileSync(join(process.cwd(), 'public/assets/car-conversion.json'), 'utf8'),
    );
    for (const entry of record.records) {
      expect(entry.frontAxis).toBe('-X');
    }
  });

  it('rotationY の補正でワールドの進行方向へ向く', () => {
    for (let step = 0; step < 32; step++) {
      const heading = (step / 32) * Math.PI * 2 - Math.PI;
      const rotated = rotateY(LOCAL_FORWARD, carRotationY(heading));
      // ワールドの進行方向は (cos H, 0, sin H)（heading = atan2(tangentZ, tangentX)）
      expect(rotated[0]).toBeCloseTo(Math.cos(heading), 10);
      expect(rotated[2]).toBeCloseTo(Math.sin(heading), 10);
      expect(rotated[1]).toBe(0);
    }
  });

  it('補正は θ = π − H（符号 −1・オフセット π）', () => {
    expect(CAR_YAW_OFFSET).toBe(Math.PI);
    expect(CAR_YAW_SIGN).toBe(-1);
    expect(carRotationY(0)).toBeCloseTo(Math.PI, 12);
    expect(carRotationY(Math.PI / 2)).toBeCloseTo(Math.PI / 2, 12);
  });

  it('ホームストレートでは車が +X を向く', () => {
    const state = raceAfter(0);
    const car = { ...state.cars[0]!, s: 150, lateral: 0, yaw: 0 };
    const heading = carWorldHeading(TRACK, car);
    expect(heading).toBeCloseTo(0, 2);
    const rotated = rotateY(LOCAL_FORWARD, carRotationY(heading));
    expect(rotated[0]).toBeGreaterThan(0.99);
    expect(Math.abs(rotated[2])).toBeLessThan(0.02);
  });

  it('ヨー角のぶんだけ車体が進行方向からずれる', () => {
    const state = raceAfter(0);
    const straight = { ...state.cars[0]!, s: 150, lateral: 0, yaw: 0 };
    const yawed = { ...straight, yaw: 0.3 };
    const delta = carWorldHeading(TRACK, yawed) - carWorldHeading(TRACK, straight);
    expect(delta).toBeCloseTo(0.3, 10);
  });

  it('車は路面の上に載る（地面へ埋まらない）', () => {
    const state = raceAfter(1500);
    for (const car of state.cars) {
      const transform = carTransform(TRACK, car, 'PS1');
      const surface = TRACK.toWorld(car.s, car.lateral);
      // 車体の原点は上下の中央にあるので、路面より上にある
      expect(transform.position[1]).toBeGreaterThan(surface[1]);
      expect(transform.position[1] - surface[1]).toBeLessThan(0.6);
    }
  });

  it('走行中も向きが連続して変わる（急に反転しない）', () => {
    const state = raceAfter(600);
    let previous = carRotationY(carWorldHeading(TRACK, state.cars[0]!));
    for (let tick = 0; tick < 600; tick++) {
      stepRace(state);
      const current = carRotationY(carWorldHeading(TRACK, state.cars[0]!));
      let delta = current - previous;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      // 1 ティックで 6°（ヨー角速度の上限 1.6 rad/s ＝ 1.5°/tick）を超えて回らない
      expect(Math.abs(delta)).toBeLessThan(0.1);
      previous = current;
    }
  });
});
