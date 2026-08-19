import { FIXED_DT_SECONDS, parseGlb, parseGltf } from '@console-chaos/engine';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { sceneryObjects, sceneryOfKinds } from '../src/game/sim/scenery.js';
import { createRaceState, type CarState } from '../src/game/sim/state.js';
import { TRACK, type TrackSample } from '../src/game/sim/track.js';
import { insideTunnel } from '../src/game/sim/tunnel.js';
import { VEHICLE, stepVehicle, wallLateral } from '../src/game/sim/vehicle.js';
import {
  TIGHT_CURVATURE,
  WALL,
  outsideSign,
  wallMaterialAt,
} from '../src/game/sim/wall.js';
import {
  TRACK_MESH_LODS,
  trackSectorAsset,
  type TrackMeshLod,
} from '../src/game/view/shared/track-mesh.js';

/**
 * 壁の位置と材質（実装計画 11-4 / R-4 / D-8・D-9・D-10）。
 *
 * 改修前に測った 3 つの食い違いを、ここで閉じる。
 *
 * 1. **シムの壁は、描かれている壁より 1.2 m 手前にあった。** コースメッシュが
 *    草地の幅を `VEHICLE.RUNOFF` にしていて、縁石 1.2 m を足し忘れていた
 * 2. **タイヤフェンスに当たり判定が無かった。** 縁から 3 m の位置に立っていて、
 *    素通りできた。壁の内貼りへ移し、材質として当たり判定に載せる
 * 3. **掠りが「大幅減」になっていなかった**（−0.5 m/s ＝ 速度の 1 %）。
 *    壁を舐めながら走るのがいちばん速いラインだった
 */

const dt = FIXED_DT_SECONDS;
const MESH_GENERATIONS = (['PS1', 'PS2'] as const).filter(
  (generation) => TRACK_MESH_LODS[generation],
);

/**
 * 断面のどの列が壁か。列の並びは 土手・［金網］・壁・草地・縁石・路面 … の鏡像で、
 * 金網を持つのは第4世代だけ（`track-mesh.spec.ts` と同じ読み方）。
 */
function wallColumn(lod: TrackMeshLod): number {
  return lod.fenceHeight === null ? 2 : 4;
}

function sideColumns(lod: TrackMeshLod): number {
  return lod.fenceHeight === null ? 8 : 10;
}

/**
 * ワールド座標 → 断面の横位置 [m]。
 * 生成側（`toWorldPoint`）の逆変換で、バンクの回転を戻すと元の `lateral` が出る。
 */
function sectionLateral(sample: TrackSample, x: number, y: number, z: number): number {
  const alongRight = (x - sample.position[0]) * sample.right[0] + (z - sample.position[2]) * sample.right[1];
  const alongUp = y - sample.position[1];
  return alongRight * Math.cos(sample.bank) + alongUp * Math.sin(sample.bank);
}

function loadSector(lod: TrackMeshLod, sector: number) {
  const bytes = readFileSync(join(process.cwd(), 'public', trackSectorAsset(lod, sector)));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const model = parseGltf(json, binary ? [binary] : []);
  return model.meshes[0]!.primitives[0]!;
}

describe('壁の位置と材質', () => {
  describe('シムの壁とコースメッシュの壁が同じ位置にある（D-9）', () => {
    for (const generation of MESH_GENERATIONS) {
      const lod = TRACK_MESH_LODS[generation]!;
      const ringWidth = sideColumns(lod) * 2 + 0; // 路面の列は下で数える

      it(`${generation}: 全セクターの壁が誤差 1 cm 以内で一致する`, () => {
        const step = TRACK.length / (lod.sectorCount * lod.segmentsPerSector);
        let checked = 0;

        for (let sector = 0; sector < lod.sectorCount; sector++) {
          const primitive = loadSector(lod, sector);
          const positions = primitive.positions;
          const columns = positions.length / 3 / (lod.segmentsPerSector + 1);
          expect(columns).toBeGreaterThan(ringWidth);

          // セクターの先頭と中央の輪を見る。1 輪でも壁がずれていれば絵と当たりが食い違う
          for (const ring of [0, lod.segmentsPerSector >> 1]) {
            const s = (sector * lod.segmentsPerSector + ring) * step;
            const sample = TRACK.sampleAt(s);
            const expected = wallLateral(sample.halfWidth);
            const base = ring * columns;
            const left = wallColumn(lod);
            for (const column of [left, left + 1, columns - 1 - left, columns - 2 - left]) {
              const offset = (base + column) * 3;
              const lateral = sectionLateral(
                sample,
                positions[offset]!,
                positions[offset + 1]!,
                positions[offset + 2]!,
              );
              expect(Math.abs(lateral), `${generation} sector ${sector} ring ${ring}`).toBeCloseTo(
                expected,
                2,
              );
              checked += 1;
            }
          }
        }
        expect(checked).toBe(lod.sectorCount * 2 * 4);
      });
    }
  });

  describe('材質（D-8）', () => {
    it('タイヤフェンスが立っている場所はすべて tyre 判定になる', () => {
      const tyres = sceneryOfKinds(sceneryObjects(TRACK), ['tyres']);
      expect(tyres.length).toBeGreaterThan(0);
      for (const object of tyres) {
        const side = object.lateral > 0 ? 1 : -1;
        expect(wallMaterialAt(TRACK, object.s, side), `id ${object.id}`).toBe('tyre');
      }
    });

    it('タイヤフェンスは壁の位置に立つ（内側 3 m ではない）', () => {
      for (const object of sceneryOfKinds(sceneryObjects(TRACK), ['tyres'])) {
        const sample = TRACK.sampleAt(object.s);
        expect(Math.abs(object.lateral)).toBeCloseTo(wallLateral(sample.halfWidth), 9);
      }
    });

    it('全周 20 m 刻みで、高曲率区間の外側だけが tyre になる', () => {
      let tyre = 0;
      let concrete = 0;
      for (let s = 0; s < TRACK.length; s += 20) {
        const sample = TRACK.sampleAt(s);
        for (const side of [-1, 1] as const) {
          const material = wallMaterialAt(TRACK, s, side);
          const expected =
            Math.abs(sample.curvature) >= TIGHT_CURVATURE &&
            outsideSign(sample.curvature) === side &&
            !insideTunnel(TRACK, s)
              ? 'tyre'
              : 'concrete';
          expect(material, `s=${s} side=${side}`).toBe(expected);
          if (material === 'tyre') tyre += 1;
          else concrete += 1;
        }
      }
      // どちらも実在する（判定が片側へ倒れていない）
      expect(tyre).toBeGreaterThan(0);
      expect(concrete).toBeGreaterThan(tyre);
    });

    it('直線とコーナーの内側はコンクリート', () => {
      const straight = TRACK.samples.find((sample) => Math.abs(sample.curvature) < 1e-4)!;
      expect(wallMaterialAt(TRACK, straight.s, 1)).toBe('concrete');
      expect(wallMaterialAt(TRACK, straight.s, -1)).toBe('concrete');

      const tight = TRACK.samples.reduce((worst, sample) =>
        Math.abs(sample.curvature) > Math.abs(worst.curvature) ? sample : worst,
      );
      const outside = outsideSign(tight.curvature);
      expect(wallMaterialAt(TRACK, tight.s, outside)).toBe('tyre');
      expect(wallMaterialAt(TRACK, tight.s, (-outside) as -1 | 1)).toBe('concrete');
    });
  });

  describe('当たりの強さ（D-10）', () => {
    /** その弧長・その側の壁へ寄せ、当たった 1 ティックで失った速度 [m/s] */
    function lossAt(s: number, side: number, speed: number, yaw: number): number {
      const car: CarState = createRaceState().cars[0]!;
      const limit = wallLateral(TRACK.sampleAt(s).halfWidth);
      car.s = s;
      car.lateral = side * (limit - 0.5);
      car.speed = speed;
      car.yaw = side * yaw;
      for (let tick = 0; tick < 60 * 2; tick++) {
        const before = car.speed;
        stepVehicle(car, { steer: 0, throttle: 1, brake: 0 }, TRACK, dt);
        if (car.hitKind === 'concrete' || car.hitKind === 'tyre') return before - car.speed;
      }
      throw new Error(`s=${s} side=${side} yaw=${yaw} で壁へ届かなかった`);
    }

    /** タイヤ壁が貼られている弧長と側 */
    const tyreSpot = (() => {
      for (let s = 0; s < TRACK.length; s += 5) {
        for (const side of [-1, 1] as const) {
          if (wallMaterialAt(TRACK, s, side) === 'tyre') return { s, side };
        }
      }
      throw new Error('タイヤ壁の区間が見つからない');
    })();

    const concreteSpot = (() => {
      const straight = TRACK.samples.find((sample) => Math.abs(sample.curvature) < 1e-4)!;
      return { s: straight.s, side: 1 as const };
    })();

    it('掠りでも速度の 8 % 以上が落ちる', () => {
      const loss = lossAt(concreteSpot.s, concreteSpot.side, 60, 0.02);
      expect(loss).toBeGreaterThanOrEqual(60 * WALL.concrete.minimumLoss * 0.9);
    });

    it('激突では 30 m/s 以上落ちる', () => {
      const loss = lossAt(concreteSpot.s, concreteSpot.side, 70, 0.6);
      expect(loss).toBeGreaterThan(30);
    });

    it('タイヤ壁はコンクリートよりよく殺す', () => {
      const tyre = lossAt(tyreSpot.s, tyreSpot.side, 50, 0.02);
      const concrete = lossAt(concreteSpot.s, concreteSpot.side, 50, 0.02);
      expect(tyre).toBeGreaterThan(concrete);
      expect(WALL.tyre.bite).toBeGreaterThan(WALL.concrete.bite);
      expect(WALL.tyre.minimumLoss).toBeGreaterThan(WALL.concrete.minimumLoss);
    });

    it('壁の種類は hitKind に出る', () => {
      const car: CarState = createRaceState().cars[0]!;
      const limit = wallLateral(TRACK.sampleAt(tyreSpot.s).halfWidth);
      car.s = tyreSpot.s;
      car.lateral = tyreSpot.side * (limit - 0.5);
      car.speed = 40;
      car.yaw = tyreSpot.side * 0.2;
      let kind = 'none';
      for (let tick = 0; tick < 120 && kind === 'none'; tick++) {
        stepVehicle(car, { steer: 0, throttle: 1, brake: 0 }, TRACK, dt);
        kind = car.hitKind;
      }
      expect(kind).toBe('tyre');
      expect(car.hitStrength).toBeGreaterThan(0);
    });
  });

  describe('復帰（9-1 の保証を壊していない）', () => {
    /** 路面へ戻るまでの秒数。戻れなければ `Infinity` */
    function secondsToRecover(s: number, side: number, speed: number): number {
      const car: CarState = createRaceState().cars[0]!;
      car.s = s;
      car.lateral = side * wallLateral(TRACK.sampleAt(s).halfWidth);
      car.speed = speed;
      car.offTrack = true;
      for (let tick = 0; tick < 60 * 20; tick++) {
        stepVehicle(car, { steer: -side, throttle: 1, brake: 0 }, TRACK, dt);
        if (!car.offTrack) return (tick + 1) * dt;
      }
      return Infinity;
    }

    it('タイヤ壁の区間でも壁ぎわから路面へ戻れる', () => {
      let spots = 0;
      for (let s = 0; s < TRACK.length; s += 20) {
        for (const side of [-1, 1] as const) {
          if (wallMaterialAt(TRACK, s, side) !== 'tyre') continue;
          spots += 1;
          for (const speed of [3, 14, 40, 70]) {
            expect(secondsToRecover(s, side, speed), `s=${s} side=${side} v=${speed}`).toBeLessThan(
              12,
            );
          }
        }
      }
      expect(spots).toBeGreaterThan(5);
    });

    it('壁のどこからでも走れる速度が残る', () => {
      for (let s = 0; s < TRACK.length; s += 40) {
        for (const side of [-1, 1] as const) {
          const car: CarState = createRaceState().cars[0]!;
          car.s = s;
          car.lateral = side * wallLateral(TRACK.sampleAt(s).halfWidth);
          car.speed = 40;
          car.offTrack = true;
          for (let tick = 0; tick < 60 * 12; tick++) {
            stepVehicle(car, { steer: -side, throttle: 1, brake: 0 }, TRACK, dt);
            if (!car.offTrack) break;
          }
          expect(car.offTrack, `s=${s} side=${side}`).toBe(false);
          expect(car.speed, `s=${s} side=${side}`).toBeGreaterThan(5);
        }
      }
    });

    it('壁は走行可能域の外に 1 つだけある（RUNOFF そのもの）', () => {
      for (const sample of TRACK.samples) {
        expect(wallLateral(sample.halfWidth) - sample.halfWidth).toBeCloseTo(VEHICLE.RUNOFF, 12);
      }
    });
  });
});
