import { HARDWARE_GENERATION_PROFILES, type CameraCommand } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { VEHICLE } from '../src/game/sim/vehicle.js';
import { CAMERA } from '../src/game/view/shared/camera.js';
import {
  CAR_MODELS,
  carGroundOffset,
  carModelScale,
} from '../src/game/view/shared/car-model.js';
import { CAR_SPRITES } from '../src/game/view/shared/car-sprite.js';
import { PLAYER_ENTRANT } from '../src/game/view/shared/variants.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 車の実寸と画面に占める大きさ（実装計画 11-5 / R-5 / D-7・D-11）。
 *
 * 素の 3D モデルは **2D スプライトの車の 44 %（幅）／ 37 %（高さ）**しかなかった。
 * 同じ 1 つのシミュレーションを描いているのに、世代で車の実寸が違っていたということで、
 * 「第3・第4世代の自機が小さい」原因はカメラではなくこれだった。12 m のコース幅に
 * 対し、素のままの 3D の車は 13.8 台が横に並べる大きさである。
 *
 * ここで固定するのは 2 つ。
 *
 * 1. **4 世代で車の実寸が一致する。** 寸法の定義はシムに 1 つだけある（D-7）
 * 2. 実寸にしたうえで**前が見える**こと。車体が画面幅の 25〜40 % に収まり、
 *    30 m 先の路面が屋根より上に残る
 */

/** ワールド座標 → NDC。`camera.spec.ts` と同じ組み方（view・projection を手で掛ける） */
function project(
  camera: CameraCommand,
  point: readonly [number, number, number],
  aspect: number,
): [number, number] {
  const forward = [
    camera.target[0] - camera.position[0],
    camera.target[1] - camera.position[1],
    camera.target[2] - camera.position[2],
  ];
  const length = Math.hypot(forward[0]!, forward[1]!, forward[2]!);
  const f = forward.map((value) => value / length) as [number, number, number];
  const right = [f[2], 0, -f[0]];
  const rightLength = Math.hypot(right[0]!, right[2]!);
  const r: [number, number, number] = [right[0]! / rightLength, 0, right[2]! / rightLength];
  const u: [number, number, number] = [
    r[1] * f[2] - r[2] * f[1],
    r[2] * f[0] - r[0] * f[2],
    r[0] * f[1] - r[1] * f[0],
  ];
  const d: [number, number, number] = [
    point[0] - camera.position[0],
    point[1] - camera.position[1],
    point[2] - camera.position[2],
  ];
  const viewX = d[0] * r[0] + d[1] * r[1] + d[2] * r[2];
  const viewY = d[0] * u[0] + d[1] * u[1] + d[2] * u[2];
  const viewZ = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  const halfTan = Math.tan((((camera.fovDegrees ?? 60) * Math.PI) / 180) / 2);
  return [viewX / (viewZ * halfTan * aspect), viewY / (viewZ * halfTan)];
}

describe('車の実寸', () => {
  it('3D モデルは車幅がシムの定義と一致する倍率で置かれる', () => {
    for (const generation of ['PS1', 'PS2'] as const) {
      const model = CAR_MODELS[generation]!;
      const scale = carModelScale(generation);
      expect(model.bounds.width * scale, `${generation} の車幅`).toBeCloseTo(
        VEHICLE.CAR_WIDTH,
        9,
      );
      // 全長は衝突判定の 4.2 m と 5 cm 以内で揃う（形は変えず倍率だけを掛けるので、
      // ぴったりにはならない。ここが大きく開いたらモデルの縦横比が変わったということ）
      expect(model.bounds.length * scale, `${generation} の全長`).toBeCloseTo(
        VEHICLE.CAR_LENGTH,
        1,
      );
      // 接地させる持ち上げも同じ倍率で伸びる
      expect(carGroundOffset(generation)).toBeCloseTo(model.bounds.bottom * scale, 9);
    }
  });

  it('2D スプライトの車幅もシムの定義と一致する（4 世代で実寸が揃う）', () => {
    // 正面のセルの絵は、セルの一辺（`cellMeters`）に対して幅がこの割合を占める。
    // 元絵を実測して決めた値で、`cellMeters` はこの積が 1.95 m になるよう選んである
    const ART_WIDTH_FRACTION = { FC: 81 / 128, SFC: 83 / 128 } as const;
    for (const generation of ['FC', 'SFC'] as const) {
      const atlas = CAR_SPRITES[generation]!;
      expect(
        atlas.cellMeters * ART_WIDTH_FRACTION[generation],
        `${generation} のスプライトの車幅`,
      ).toBeCloseTo(VEHICLE.CAR_WIDTH, 1);
    }
  });

  describe('画面に占める大きさ（D-11）', () => {
    for (const generation of ['PS1', 'PS2'] as const) {
      describe(generation, () => {
        const profile = HARDWARE_GENERATION_PROFILES[generation];
        const aspect = profile.video.internalWidth / profile.video.internalHeight;
        const state = raceAfter(900);
        const player = state.cars[PLAYER_ENTRANT]!;
        player.lateral = 0;
        player.yaw = 0;
        player.speed = 40;
        const camera = buildFrame(generation, state, 10, 1, 'racing', 'chase').camera!;
        const track = state.track;
        const scale = carModelScale(generation);
        const model = CAR_MODELS[generation]!;
        const ground = carGroundOffset(generation);

        /** 車体の後面（自機の位置）の左右の端と屋根 */
        const rear = (lateral: number, height: number) => {
          const world = track.toWorld(player.s - VEHICLE.CAR_LENGTH / 2, lateral);
          return project(camera, [world[0], world[1] + height, world[2]], aspect);
        };

        it('車体が画面幅の 25〜40 % を占める', () => {
          const half = VEHICLE.CAR_WIDTH / 2;
          const left = rear(-half, ground)[0];
          const right = rear(half, ground)[0];
          // NDC の幅 2 が画面幅
          const fraction = Math.abs(right - left) / 2;
          expect(fraction, `${generation} の車幅 ${(fraction * 100).toFixed(1)} %`).toBeGreaterThan(
            0.25,
          );
          expect(fraction).toBeLessThan(0.4);
        });

        it('30 m 先の路面が屋根より上に残る（車体が前を塞がない）', () => {
          const roofHeight = ground + model.bounds.height * scale;
          const roof = rear(0, roofHeight)[1];
          const aheadWorld = track.toWorld(player.s + 30, 0);
          const ahead = project(camera, [aheadWorld[0], aheadWorld[1], aheadWorld[2]], aspect);
          // NDC は上が正。30 m 先の路面が屋根より上 ＝ 値が大きい
          expect(ahead[1], `${generation} の 30 m 先の路面`).toBeGreaterThan(roof);
        });

        it('自機は画面の中央付近に居る', () => {
          expect(Math.abs(rear(0, ground)[0])).toBeLessThan(0.1);
        });
      });
    }
  });

  it('カメラは実寸の車に合わせて引いてある（8-4 の 3.2 m ではない）', () => {
    expect(CAMERA.BEHIND).toBeGreaterThan(VEHICLE.CAR_LENGTH);
    // 目線を上げないと屋根の行と 30 m 先の路面の行がほぼ重なる（§4.6 の投影計算）
    expect(CAMERA.HEIGHT).toBeGreaterThan(1.4);
  });
});
