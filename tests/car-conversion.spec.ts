import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGlb, parseGltf, type GltfModel, type GltfPrimitive } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { VEHICLE } from '../src/game/sim/vehicle.js';
import { CAR_MODELS } from '../src/game/view/shared/car-model.js';

/**
 * 変換器が焼き込んだ正規化が現物に効いているかを検査する
 * （車モデル入れ替え計画 §6.2）。
 *
 * 実行時の `TransformCommand` は `rotationY` と等方 scale しか持たないので、
 * 変換元との姿勢・原点・寸法の差は `tools/prepare-cars.mjs` が焼き込む。
 * **焼けているかは成果物を読むしか確かめようがない。** モデルを差し替えたとき
 * ヨーを戻し忘れる／中心合わせを忘れるといった取りこぼしは、どれも例外にならず
 * 「斜めに走る車」「路面に埋まる車」として画面にだけ出る。
 *
 * `car-orientation.spec.ts` は**実行時の回転の式**を、こちらは**モデルそのもの**を
 * 固定する。両方が要る。
 */

/** 変換記録。`bounds` はこの JSON が正で、`CAR_MODELS` はそれを写したもの */
interface ConversionRecord {
  version: number;
  records: {
    generation: 'PS1' | 'PS2';
    normalize: { yawDegrees: number; targetWidth: number; lengthPerWidth?: number };
    runtime: { model: { path: string } };
    geometry: { triangles: number; vertices: number; bounds: { min: number[]; max: number[] } };
    frontAxis: string;
  }[];
}

const record: ConversionRecord = JSON.parse(
  readFileSync(join(process.cwd(), 'public/assets/car-conversion.json'), 'utf8'),
);

function loadCar(generation: 'PS1' | 'PS2'): { model: GltfModel; primitive: GltfPrimitive } {
  const bytes = readFileSync(join(process.cwd(), 'public', CAR_MODELS[generation]!.asset));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const model = parseGltf(json, binary ? [binary] : []);
  expect(model.meshes).toHaveLength(1);
  expect(model.meshes[0]!.primitives).toHaveLength(1);
  return { model, primitive: model.meshes[0]!.primitives[0]! };
}

function entryFor(generation: 'PS1' | 'PS2') {
  const entry = record.records.find((item) => item.generation === generation);
  expect(entry, `${generation} の変換記録`).toBeDefined();
  return entry!;
}

/**
 * 点 p と三角形 abc の距離。低ポリのメッシュでは頂点どうしを突き合わせても
 * 相手が居ない（三角形分割そのものが左右で違う）ので、**面までの距離**で測る。
 * Ericson, *Real-Time Collision Detection* の重心座標による領域判定。
 */
function pointTriangleDistance(
  p: readonly [number, number, number],
  positions: Float32Array,
  ia: number,
  ib: number,
  ic: number,
): number {
  const ax = positions[ia]!;
  const ay = positions[ia + 1]!;
  const az = positions[ia + 2]!;
  const abx = positions[ib]! - ax;
  const aby = positions[ib + 1]! - ay;
  const abz = positions[ib + 2]! - az;
  const acx = positions[ic]! - ax;
  const acy = positions[ic + 1]! - ay;
  const acz = positions[ic + 2]! - az;
  const apx = p[0] - ax;
  const apy = p[1] - ay;
  const apz = p[2] - az;

  const d1 = abx * apx + aby * apy + abz * apz;
  const d2 = acx * apx + acy * apy + acz * apz;
  if (d1 <= 0 && d2 <= 0) return Math.hypot(apx, apy, apz);

  const bpx = apx - abx;
  const bpy = apy - aby;
  const bpz = apz - abz;
  const d3 = abx * bpx + aby * bpy + abz * bpz;
  const d4 = acx * bpx + acy * bpy + acz * bpz;
  if (d3 >= 0 && d4 <= d3) return Math.hypot(bpx, bpy, bpz);

  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return Math.hypot(apx - v * abx, apy - v * aby, apz - v * abz);
  }

  const cpx = apx - acx;
  const cpy = apy - acy;
  const cpz = apz - acz;
  const d5 = abx * cpx + aby * cpy + abz * cpz;
  const d6 = acx * cpx + acy * cpy + acz * cpz;
  if (d6 >= 0 && d5 <= d6) return Math.hypot(cpx, cpy, cpz);

  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return Math.hypot(apx - w * acx, apy - w * acy, apz - w * acz);
  }

  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + (d5 - d6));
    return Math.hypot(
      apx - abx - w * (acx - abx),
      apy - aby - w * (acy - aby),
      apz - abz - w * (acz - abz),
    );
  }

  const denominator = 1 / (va + vb + vc);
  const v = vb * denominator;
  const w = vc * denominator;
  return Math.hypot(
    apx - (v * abx + w * acx),
    apy - (v * aby + w * acy),
    apz - (v * abz + w * acz),
  );
}

/** 三角形を均一グリッドへ登録して最近傍の面探索を絞る（総当たりは 8,000 万回になる） */
function buildTriangleGrid(primitive: GltfPrimitive, cell: number) {
  const { positions, indices } = primitive;
  const buckets = new Map<string, number[]>();
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let corner = 0; corner < 3; corner++) {
      const base = indices[triangle + corner]! * 3;
      minX = Math.min(minX, positions[base]!);
      maxX = Math.max(maxX, positions[base]!);
      minY = Math.min(minY, positions[base + 1]!);
      maxY = Math.max(maxY, positions[base + 1]!);
      minZ = Math.min(minZ, positions[base + 2]!);
      maxZ = Math.max(maxZ, positions[base + 2]!);
    }
    for (let x = Math.floor(minX / cell); x <= Math.floor(maxX / cell); x++) {
      for (let y = Math.floor(minY / cell); y <= Math.floor(maxY / cell); y++) {
        for (let z = Math.floor(minZ / cell); z <= Math.floor(maxZ / cell); z++) {
          const key = `${x},${y},${z}`;
          const bucket = buckets.get(key);
          if (bucket) bucket.push(triangle);
          else buckets.set(key, [triangle]);
        }
      }
    }
  }
  return buckets;
}

/** 点から車体の表面までの距離。セルの輪を外へ広げ、確定したら打ち切る */
function distanceToSurface(
  primitive: GltfPrimitive,
  buckets: Map<string, number[]>,
  cell: number,
  point: readonly [number, number, number],
): number {
  const gx = Math.floor(point[0] / cell);
  const gy = Math.floor(point[1] / cell);
  const gz = Math.floor(point[2] / cell);
  const visited = new Set<number>();
  let best = Infinity;

  for (let ring = 0; ring <= 8; ring++) {
    for (let dx = -ring; dx <= ring; dx++) {
      for (let dy = -ring; dy <= ring; dy++) {
        for (let dz = -ring; dz <= ring; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dz)) !== ring) continue;
          const bucket = buckets.get(`${gx + dx},${gy + dy},${gz + dz}`);
          if (!bucket) continue;
          for (const triangle of bucket) {
            if (visited.has(triangle)) continue;
            visited.add(triangle);
            const distance = pointTriangleDistance(
              point,
              primitive.positions,
              primitive.indices[triangle]! * 3,
              primitive.indices[triangle + 1]! * 3,
              primitive.indices[triangle + 2]! * 3,
            );
            if (distance < best) best = distance;
          }
        }
      }
    }
    // 確定した半径の内側にすでに面が居れば、外の輪を見る必要は無い
    if (best <= ring * cell) break;
  }
  return best;
}

/**
 * 左右対称性。頂点を `z → −z` で鏡映し、車体の表面までの距離を測る。
 *
 * これが受け持つのは**ヨーの取りこぼし全般** — 回転を忘れた・符号を間違えた・
 * 90° ずれた、といった「車が斜めに走る」類の壊れ方である。記録の値を 1 桁でも
 * 変えたことは前段の bounds 検査（9 桁一致）が確実に捉えるので、ここまで
 * 厳しくする必要は無い。
 *
 * 許容 10 mm はモデル単位（1 単位 ≒ 2.25 m）。正規化のヨーを 0.5° 動かして
 * 焼き直したときの実測:
 *
 * | ヨー | PS1 中央値 / 10 mm 以内 | PS2 中央値 / 10 mm 以内 |
 * | --- | --- | --- |
 * | −0.5° | 6.67 mm / 69.7 % | 4.53 mm / 81.7 % |
 * | **記録値** | **4.20 mm / 81.8 %** | **2.88 mm / 95.4 %** |
 * | +0.5° | 6.44 mm / 72.8 % | 3.54 mm / 82.3 % |
 *
 * 第3世代は 0.5° のずれで中央値の判定が落ちる。第4世代はメッシュが素直なぶん
 * 余裕があり、単独で捉えられるのは 1.5° 以上のずれになる（0.5° は bounds 側で落ちる）。
 *
 * 許容を 6 mm へ締めると第3世代（964 tri）が**正しい変換でも** 62 % しか通らない。
 * これはヨーの残りではなく変換元のメッシュ自体が厳密には対称でないためで、
 * 締めても検出力は上がらず、正しい変換が落ちるだけになる。
 */
function mirrorDistances(primitive: GltfPrimitive): number[] {
  const cell = 0.02;
  const buckets = buildTriangleGrid(primitive, cell);
  const distances: number[] = [];
  for (let base = 0; base < primitive.positions.length; base += 3) {
    distances.push(
      distanceToSurface(primitive, buckets, cell, [
        primitive.positions[base]!,
        primitive.positions[base + 1]!,
        -primitive.positions[base + 2]!,
      ]),
    );
  }
  return distances.sort((a, b) => a - b);
}

const GENERATIONS = ['PS1', 'PS2'] as const;

describe('車モデルの変換', () => {
  it('記録は v2（fingerprint を持たない）', () => {
    expect(record.version).toBe(2);
    for (const entry of record.records) {
      // 「レンダラー正規形の指紋」は成果物から復元できず、更新もされていなかった。
      // 新しい形状に旧い指紋が残るほうが有害なので落とした（D-8）
      expect(entry.geometry).not.toHaveProperty('fingerprint');
      expect(entry.normalize.yawDegrees).toBeTypeOf('number');
    }
  });

  for (const generation of GENERATIONS) {
    describe(generation, () => {
      const { model, primitive } = loadCar(generation);
      const entry = entryFor(generation);
      const bounds = CAR_MODELS[generation]!.bounds;

      it('runtime GLB は material も image も持たない（色は実行時の乗算 1 つで決まる）', () => {
        expect(model.materials).toHaveLength(0);
        expect(model.images).toHaveLength(0);
        expect(model.skins).toHaveLength(0);
        expect(model.animations).toHaveLength(0);
        expect(primitive.material).toBeNull();
        expect(primitive.joints).toBeNull();
        expect(primitive.weights).toBeNull();
        expect(primitive.uvs).not.toBeNull();
        expect(primitive.normals).not.toBeNull();
      });

      it('三角形数と頂点数が記録どおり', () => {
        expect(primitive.indices.length / 3).toBe(entry.geometry.triangles);
        expect(primitive.positions.length / 3).toBe(entry.geometry.vertices);
      });

      it('頂点の実測 bounds が記録の min/max と一致する', () => {
        // accessor の min/max はコピーではなく変換後の値から採り直している。
        // ここを取りこぼすと記録と現物が食い違い、CAR_MODELS.bounds が嘘になる
        const min = [Infinity, Infinity, Infinity];
        const max = [-Infinity, -Infinity, -Infinity];
        for (let base = 0; base < primitive.positions.length; base += 3) {
          for (let axis = 0; axis < 3; axis++) {
            const value = primitive.positions[base + axis]!;
            if (value < min[axis]!) min[axis] = value;
            if (value > max[axis]!) max[axis] = value;
          }
        }
        for (let axis = 0; axis < 3; axis++) {
          expect(min[axis], `min[${axis}]`).toBeCloseTo(entry.geometry.bounds.min[axis]!, 9);
          expect(max[axis], `max[${axis}]`).toBeCloseTo(entry.geometry.bounds.max[axis]!, 9);
        }
        // CAR_MODELS は記録を写したもの。写し間違いはここで落ちる
        expect(max[0]! - min[0]!).toBeCloseTo(bounds.length, 6);
        expect(max[1]! - min[1]!).toBeCloseTo(bounds.height, 6);
        expect(max[2]! - min[2]!).toBeCloseTo(bounds.width, 6);
        expect(-min[1]!).toBeCloseTo(bounds.bottom, 6);
      });

      it('bounds の中心が原点にある（中心合わせが焼けている）', () => {
        // 素のモデルは底面が Y = 0（接地基準）。放置すると carGroundOffset が 0 になり
        // 車が路面へ埋まる。1 mm はモデル単位（実寸では 2.3 mm）
        for (let axis = 0; axis < 3; axis++) {
          const center = (entry.geometry.bounds.min[axis]! + entry.geometry.bounds.max[axis]!) / 2;
          expect(Math.abs(center), `軸 ${axis} の中心`).toBeLessThan(0.001);
        }
        expect(bounds.bottom).toBeGreaterThan(0);
      });

      it('左右対称である（ヨーが残っていない）', () => {
        const distances = mirrorDistances(primitive);
        const median = distances[Math.floor(distances.length / 2)]!;
        const within = distances.filter((distance) => distance < 0.01).length / distances.length;
        expect(median, `${generation} の鏡映誤差の中央値`).toBeLessThan(0.006);
        expect(within, `${generation} の 10 mm 以内の割合`).toBeGreaterThan(0.75);
      });

      it('前方が -X（車高の低い側が鼻先）', () => {
        expect(entry.frontAxis).toBe('-X');
        // 前後の端 15 % ずつを見て、屋根の高い側を後ろとみなす
        const band = bounds.length * 0.15;
        const front = -bounds.length / 2 + band;
        const rear = bounds.length / 2 - band;
        let frontHeight = -Infinity;
        let rearHeight = -Infinity;
        for (let base = 0; base < primitive.positions.length; base += 3) {
          const x = primitive.positions[base]!;
          const y = primitive.positions[base + 1]!;
          if (x < front && y > frontHeight) frontHeight = y;
          if (x > rear && y > rearHeight) rearHeight = y;
        }
        expect(frontHeight, `${generation} の鼻先が -X 側にない`).toBeLessThan(rearHeight);
      });

      it('全長 / 車幅がシムの比と一致する（見た目より先に当たる車にならない）', () => {
        // 相似に縮めると全長が 3.8 m になり、衝突判定の 4.2 m と食い違う（D-4）。
        // 記録から lengthPerWidth を消すと相似縮小へ落ちるので、その取りこぼしもここで落ちる
        expect(entry.normalize.lengthPerWidth).toBeCloseTo(
          VEHICLE.CAR_LENGTH / VEHICLE.CAR_WIDTH,
          12,
        );
        const ratio = bounds.length / bounds.width;
        expect(ratio / (VEHICLE.CAR_LENGTH / VEHICLE.CAR_WIDTH)).toBeCloseTo(1, 2);
      });

      it('車幅が記録の targetWidth に載っている', () => {
        // ここが現行と同じ値であることが「carModelScale が変わらない」の中身
        expect(bounds.width).toBeCloseTo(entry.normalize.targetWidth, 5);
      });
    });
  }
});
