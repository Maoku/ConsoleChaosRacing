import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseGlb, parseGltf } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { VEHICLE } from '../src/game/sim/vehicle.js';
import {
  CAR_LAMP_COLORS,
  CAR_LAMP_SHAPE,
  CAR_MODELS,
  CAR_WHEELS,
  carLampsFor,
  carModelScale,
  carTextureFor,
  carWheelAsset,
  carWheelPhase,
} from '../src/game/view/shared/car-model.js';
import { decodePng } from '../tools/lib/png.mjs';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 車輪とテールランプ（実装計画 フェーズ 12-7）。
 *
 * 実行時の `TransformCommand` は `rotationY` しか持たないので、**車軸まわりの回転は
 * 実行時には作れない**。車輪は位相を焼いた 8 枚の GLB から 1 枚を選んで回し、
 * 灯火は別メッシュとして持って `MeshCommand.color` の乗算で明るさを作る。
 *
 * どちらも「焼いた成果物」と「実行時の引き方」の両方が正しくないと画面に出ない。
 * ここは**成果物のほう**（位相が本当に車軸まわりに回っているか・灯火が後ろを向いた
 * 左右対称な板になっているか）と、フレームの積み方の両方を固定する。
 */

interface WheelRecord {
  phases: number;
  triangles: number;
  vertices: number;
  radius: number;
  axles: number[][];
  files: { path: string; bytes: number }[];
}

const record: {
  records: {
    generation: 'PS1' | 'PS2';
    runtime: { wheels: WheelRecord };
  }[];
} = JSON.parse(readFileSync(join(process.cwd(), 'public/assets/car-conversion.json'), 'utf8'));

const GENERATIONS = ['PS1', 'PS2'] as const;

function loadPart(url: string) {
  const bytes = readFileSync(join(process.cwd(), 'public', url));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  );
  const model = parseGltf(json, binary ? [binary] : []);
  expect(model.meshes).toHaveLength(1);
  return { model, primitive: model.meshes[0]!.primitives[0]! };
}

function boundsOf(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let base = 0; base < positions.length; base += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[base + axis]!;
      if (value < min[axis]!) min[axis] = value;
      if (value > max[axis]!) max[axis] = value;
    }
  }
  return { min, max };
}

/** その頂点がいちばん近い車軸。車輪は四隅に離れているので取り違えようがない */
function nearestAxle(axles: number[][], x: number, y: number, z: number): number[] {
  let best = axles[0]!;
  let distance = Infinity;
  for (const axle of axles) {
    const current = Math.hypot(x - axle[0]!, y - axle[1]!, z - axle[2]!);
    if (current < distance) {
      distance = current;
      best = axle;
    }
  }
  return best;
}

describe('車輪', () => {
  for (const generation of GENERATIONS) {
    describe(generation, () => {
      const wheels = CAR_WHEELS[generation]!;
      const entry = record.records.find((item) => item.generation === generation)!;
      const phase0 = loadPart(carWheelAsset(generation, 0)).primitive;

      it('定数が変換記録を写している', () => {
        // 半径は転がりの位相を決める値であり、**手で書いた値ではない**
        expect(wheels.phases).toBe(entry.runtime.wheels.phases);
        expect(wheels.radius).toBeCloseTo(entry.runtime.wheels.radius, 12);
        expect(entry.runtime.wheels.files).toHaveLength(wheels.phases);
        expect(entry.runtime.wheels.axles).toHaveLength(4);
      });

      it('位相ぶんの GLB が揃い、どれも同じ形をしている', () => {
        for (let phase = 0; phase < wheels.phases; phase++) {
          const { model, primitive } = loadPart(carWheelAsset(generation, phase));
          // 車体と同じ規約: material も image も持たない（色は実行時の乗算 1 つ）
          expect(model.materials, `位相 ${phase}`).toHaveLength(0);
          expect(model.images, `位相 ${phase}`).toHaveLength(0);
          expect(model.skins, `位相 ${phase}`).toHaveLength(0);
          expect(model.animations, `位相 ${phase}`).toHaveLength(0);
          expect(primitive.uvs, `位相 ${phase}`).not.toBeNull();
          expect(primitive.positions.length, `位相 ${phase} の頂点数`).toBe(
            phase0.positions.length,
          );
          expect(primitive.indices.length, `位相 ${phase} の三角形数`).toBe(phase0.indices.length);
        }
      });

      it('位相が違えば頂点が動いている（同じ絵を 8 枚焼いていない）', () => {
        for (let phase = 1; phase < wheels.phases; phase++) {
          const positions = loadPart(carWheelAsset(generation, phase)).primitive.positions;
          let moved = 0;
          for (let base = 0; base < positions.length; base += 3) {
            if (Math.abs(positions[base]! - phase0.positions[base]!) > 1e-4) moved += 1;
          }
          expect(moved / (positions.length / 3), `位相 ${phase}`).toBeGreaterThan(0.9);
        }
      });

      it('半周の位相が車軸まわりの点対称になっている', () => {
        // 180° 回転は (u, v) → (−u, −v) なので、**異方倍率に関係なく**
        // 車軸を中心とした点対称になる。回転の中心が記録の車軸と違えばここで落ちる
        const half = loadPart(carWheelAsset(generation, wheels.phases / 2)).primitive.positions;
        let worst = 0;
        for (let base = 0; base < half.length; base += 3) {
          const x = phase0.positions[base]!;
          const y = phase0.positions[base + 1]!;
          const z = phase0.positions[base + 2]!;
          const axle = nearestAxle(entry.runtime.wheels.axles, x, y, z);
          worst = Math.max(
            worst,
            Math.hypot(
              half[base]! - (2 * axle[0]! - x),
              half[base + 1]! - (2 * axle[1]! - y),
              half[base + 2]! - z,
            ),
          );
        }
        expect(worst).toBeLessThan(1e-6);
      });

      it('回しても輪郭がほとんど動かない（変換元の空間で回している）', () => {
        // 正規化は前後だけ 1.10 倍なので、そのまま回すと楕円が首を振る。
        // 変換元の空間へ戻して回すと bounds のぶれが 1/2〜1/3 になる（実測）:
        // そのまま回す 0.0160 / 0.0239、変換元の空間 0.0050 / 0.0110
        const limit = generation === 'PS1' ? 0.006 : 0.012;
        const base = boundsOf(phase0.positions);
        for (let phase = 1; phase < wheels.phases; phase++) {
          const bounds = boundsOf(loadPart(carWheelAsset(generation, phase)).primitive.positions);
          for (let axis = 0; axis < 3; axis++) {
            expect(Math.abs(bounds.min[axis]! - base.min[axis]!), `位相 ${phase} min`).toBeLessThan(
              limit,
            );
            expect(Math.abs(bounds.max[axis]! - base.max[axis]!), `位相 ${phase} max`).toBeLessThan(
              limit,
            );
          }
        }
      });

      it('車輪は車体の四隅の下にあり、車体からは抜けている', () => {
        const body = loadPart(CAR_MODELS[generation]!.asset).primitive;
        const bodyBounds = boundsOf(body.positions);
        const wheelBounds = boundsOf(phase0.positions);
        // 接地しているのは車輪。車体だけでは最下点が上がる
        expect(wheelBounds.min[1]!).toBeLessThan(bodyBounds.min[1]!);
        expect(wheelBounds.min[1]!).toBeCloseTo(-CAR_MODELS[generation]!.bounds.bottom, 6);
        for (const axle of entry.runtime.wheels.axles) {
          expect(axle[1]!, '車軸が車体の下半分にない').toBeLessThan(0);
          expect(Math.abs(axle[2]!), '車軸が中央寄りすぎる').toBeGreaterThan(
            CAR_MODELS[generation]!.bounds.width * 0.25,
          );
        }
      });

      it('転がりの位相が走った距離で決まる', () => {
        const circumference = 2 * Math.PI * wheels.radius * carModelScale(generation);
        // 実寸の外周は 1.6〜1.8 m。1 周ぶん進むと位相がちょうど一巡する
        expect(circumference).toBeGreaterThan(1.4);
        expect(circumference).toBeLessThan(2);
        expect(carWheelPhase(generation, 0)).toBe(0);
        expect(carWheelPhase(generation, circumference)).toBe(0);
        for (let step = 0; step < wheels.phases; step++) {
          const distance = (circumference * (step + 0.5)) / wheels.phases;
          expect(carWheelPhase(generation, distance), `${step} 段目`).toBe(step);
        }
        // 1 周のあいだに全位相が 1 度ずつ出る（飛ばさない・止まらない）
        const seen = new Set<number>();
        for (let sample = 0; sample < 400; sample++) {
          seen.add(carWheelPhase(generation, (circumference * sample) / 400));
        }
        expect(seen.size).toBe(wheels.phases);
      });
    });
  }
});

describe('テールランプ', () => {
  for (const generation of GENERATIONS) {
    describe(generation, () => {
      const lamps = carLampsFor(generation)!;
      const { model, primitive } = loadPart(lamps.asset);
      const body = loadPart(CAR_MODELS[generation]!.asset).primitive;

      it('左右 1 本ずつの帯で、面は後ろ（+X）を向く', () => {
        expect(model.materials).toHaveLength(0);
        expect(model.images).toHaveLength(0);
        // 左右 2 本 × 列 `columns`（1 列 2 三角形・頂点は列の境目で共有）
        expect(primitive.indices.length / 3).toBe(CAR_LAMP_SHAPE.columns * 2 * 2);
        expect(primitive.positions.length / 3).toBe((CAR_LAMP_SHAPE.columns + 1) * 2 * 2);
        for (let base = 0; base < primitive.normals!.length; base += 3) {
          expect(primitive.normals![base]).toBe(1);
          expect(primitive.normals![base + 1]).toBe(0);
          expect(primitive.normals![base + 2]).toBe(0);
        }
        // 巻き方も +X 向き。裏返っていると背面カリングで 1 画素も出ない
        for (let triangle = 0; triangle < primitive.indices.length; triangle += 3) {
          const [a, b, c] = [0, 1, 2].map((corner) => primitive.indices[triangle + corner]! * 3);
          const cross =
            (primitive.positions[b! + 1]! - primitive.positions[a! + 1]!) *
              (primitive.positions[c! + 2]! - primitive.positions[a! + 2]!) -
            (primitive.positions[b! + 2]! - primitive.positions[a! + 2]!) *
              (primitive.positions[c! + 1]! - primitive.positions[a! + 1]!);
          expect(cross, `三角形 ${triangle / 3} の表裏`).toBeGreaterThan(0);
        }
      });

      it('車体の後端に載り、左右対称に並ぶ', () => {
        const bodyBounds = boundsOf(body.positions);
        const bounds = boundsOf(primitive.positions);
        // 面の上へ押し出してある（第4世代の深度バッファで Z ファイトしない）。
        // **列ごとに車体表面の X を測り直す**ので、外側ほど前（-X）へ回り込む。
        // 1 つの X に平らな板を置くと外端が車体からはみ出す（実機の画面で確認した）
        expect(bounds.max[0]!).toBeGreaterThan(bounds.min[0]!);
        expect(bounds.min[0]!).toBeGreaterThan(
          bodyBounds.max[0]! - CAR_LAMP_SHAPE.band * bodyBounds.max[0]! * 2,
        );
        expect(bounds.max[0]!).toBeLessThan(bodyBounds.max[0]! + CAR_LAMP_SHAPE.offset * 2);
        // いちばん外の列がいちばん前（＝丸みに沿っている）
        const outermost = { x: Infinity, z: 0 };
        const innermost = { x: -Infinity, z: 0 };
        for (let base = 0; base < primitive.positions.length; base += 3) {
          const x = primitive.positions[base]!;
          const z = Math.abs(primitive.positions[base + 2]!);
          if (z > outermost.z || (z === outermost.z && x < outermost.x)) {
            outermost.z = z;
            outermost.x = x;
          }
          if (innermost.z === 0 || z < innermost.z) {
            innermost.z = z;
            innermost.x = x;
          }
        }
        expect(outermost.x).toBeLessThanOrEqual(innermost.x);
        // 高さは車体の中。屋根から飛び出していたら測り方が壊れている
        expect(bounds.min[1]!).toBeGreaterThan(bodyBounds.min[1]!);
        expect(bounds.max[1]!).toBeLessThan(bodyBounds.max[1]!);
        expect(bounds.max[1]! - bounds.min[1]!).toBeCloseTo(CAR_LAMP_SHAPE.halfHeight * 2, 6);

        const left = [...primitive.positions].filter((_unused, index) => index % 3 === 2);
        const positive = left.filter((z) => z > 0).sort((a, b) => a - b);
        const negative = left
          .filter((z) => z < 0)
          .map((z) => -z)
          .sort((a, b) => a - b);
        expect(positive).toHaveLength((CAR_LAMP_SHAPE.columns + 1) * 2);
        expect(positive).toEqual(negative);
        const halfWidth = CAR_MODELS[generation]!.bounds.width / 2;
        expect(positive[0]! / halfWidth).toBeCloseTo(CAR_LAMP_SHAPE.inner, 6);
        expect(positive[positive.length - 1]! / halfWidth).toBeCloseTo(CAR_LAMP_SHAPE.outer, 6);
      });

      it('引くのは塗装テクスチャの明るい無彩色テクセル 1 点だけ', () => {
        // 灯火の色は実行時の乗算だけで決まる。**テクスチャは 1 枚も増えていない**
        const uvs = primitive.uvs!;
        for (let base = 2; base < uvs.length; base += 2) {
          expect(uvs[base]).toBe(uvs[0]);
          expect(uvs[base + 1]).toBe(uvs[1]);
        }
        const image = decodePng(
          readFileSync(join(process.cwd(), 'public', carTextureFor(generation))),
        );
        const x = Math.floor(uvs[0]! * image.width);
        const y = Math.floor(uvs[1]! * image.height);
        const offset = (y * image.width + x) * 4;
        const channels = [image.pixels[offset]!, image.pixels[offset + 1]!, image.pixels[offset + 2]!];
        const max = Math.max(...channels) / 255;
        const min = Math.min(...channels) / 255;
        // 暗いテクセルを引くと、赤を掛けても点いて見えない
        expect(max).toBeGreaterThan(0.8);
        expect((max - min) / max, '無彩色でない').toBeLessThan(0.22);
      });
    });
  }
});

describe('車 1 台ぶんの積み方', () => {
  it('第3世代は車輪 → 車体 → 灯火の順に、すべて同じスロットへ積む', () => {
    // 深度バッファが無いので前後は積んだ順で決まる。車輪を先に置くと、
    // 向こう側の車輪とフェンダーに隠れる部分を車体が上書きしてくれる
    const frame = buildFrame('PS1', raceAfter(1500));
    const ids = frame.meshes.filter((mesh) => mesh.id.includes('-PS1-0')).map((mesh) => mesh.id);
    expect(ids).toEqual(['car-wheels-PS1-0', 'car-PS1-0', 'car-lamp-PS1-0']);
    for (const mesh of frame.meshes.filter((mesh) => mesh.id.startsWith('car-'))) {
      expect(mesh.orderTableIndex, mesh.id).toBe(9);
    }
  });

  it('第4世代は描画順の指定を持たない（深度バッファに任せる）', () => {
    const frame = buildFrame('PS2', raceAfter(1500));
    const parts = frame.meshes.filter((mesh) => mesh.id.includes('-PS2-0'));
    expect(parts.map((mesh) => mesh.id)).toContain('car-wheels-PS2-0');
    expect(parts.map((mesh) => mesh.id)).toContain('car-lamp-PS2-0');
    for (const mesh of parts) expect(mesh.orderTableIndex, mesh.id).toBeUndefined();
  });

  for (const generation of GENERATIONS) {
    it(`${generation}: 車輪の位相が走行で進む`, () => {
      const state = raceAfter(600);
      const before = buildFrame(generation, state).meshes.find(
        (mesh) => mesh.id === `car-wheels-${generation}-0`,
      )!;
      // 外周の半分ぶん進める ＝ 位相はちょうど半周ぶん進む。
      // 位相が変わらないなら、走った距離から位相を引いていないということ
      const circumference =
        2 * Math.PI * CAR_WHEELS[generation]!.radius * carModelScale(generation);
      const moved = { ...state, cars: state.cars.map((car) => ({ ...car })) };
      moved.cars[0]!.s = state.track.wrapS(state.cars[0]!.s + circumference / 2);
      const after = buildFrame(generation, moved).meshes.find(
        (mesh) => mesh.id === `car-wheels-${generation}-0`,
      )!;
      expect(before.asset).not.toBe(after.asset);
    });

    it(`${generation}: ブレーキで灯火が明るくなる`, () => {
      const state = raceAfter(1500);
      const lampColor = (brake: number) => {
        const next = { ...state, cars: state.cars.map((car) => ({ ...car, brakeInput: brake })) };
        return buildFrame(generation, next).meshes.find(
          (mesh) => mesh.id === `car-lamp-${generation}-0`,
        )?.color;
      };
      expect(lampColor(0)).toBe(CAR_LAMP_COLORS.idle);
      expect(lampColor(1)).toBe(CAR_LAMP_COLORS.brake);
      // 中間も混ざる（0/1 の二値ではない）
      const half = lampColor(0.5)!;
      expect(half).not.toBe(CAR_LAMP_COLORS.idle);
      expect(half).not.toBe(CAR_LAMP_COLORS.brake);
    });

    it(`${generation}: 前から見ている車には灯火を積まない`, () => {
      // 板は後ろ向きの一枚面なので GPU の背面カリングで消える。
      // **絵は変わらないがドローコールだけが残る**ので、積む前に落とす
      const state = raceAfter(1500);
      const player = state.cars[0]!;
      const rival = state.cars[1]!;
      // 自機の 20 m 前に、こちらを向いて（ヨー 180°）止まっているライバル
      rival.s = state.track.wrapS(player.s + 20);
      rival.lateral = 0;
      rival.yaw = Math.PI;
      const frame = buildFrame(generation, state);
      const ids = frame.meshes.map((mesh) => mesh.id);
      expect(ids).toContain(`car-${generation}-1`);
      expect(ids).not.toContain(`car-lamp-${generation}-1`);
      // 自機は後ろから見ているので灯火が出る
      expect(ids).toContain(`car-lamp-${generation}-0`);
    });
  }

  it('車輪 1 回転の距離がシムの車と釣り合っている', () => {
    // 実寸の車輪（直径 0.5〜0.7 m）。極端に小さいと猛烈に回り、大きいと止まって見える
    for (const generation of GENERATIONS) {
      const diameter = 2 * CAR_WHEELS[generation]!.radius * carModelScale(generation);
      expect(diameter, `${generation} の車輪の直径`).toBeGreaterThan(0.45);
      expect(diameter, `${generation} の車輪の直径`).toBeLessThan(0.7);
      expect(diameter).toBeLessThan(VEHICLE.CAR_WIDTH / 2);
    }
  });
});
