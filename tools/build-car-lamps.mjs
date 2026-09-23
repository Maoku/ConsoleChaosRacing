#!/usr/bin/env tsx
/**
 * テールランプのメッシュ（実装計画 フェーズ 12-7）。
 *
 *   npm run build:lamps
 *
 * 第3・第4世代の車体 GLB から**後ろ姿を実測して**、灯火の板を左右 1 枚ずつ焼く。
 *
 * ## なぜ別メッシュなのか
 *
 * 元のテクスチャには赤い灯火が描かれているが、塗装テクスチャ（`build-car-paint.mjs`）が
 * 塗装を無彩色へ均すので、実行時に赤は残らない。`MaterialCommand.emissiveTexture` は
 * 型にあるだけで**レンダラーが読んでいない**（`uBaseColor` / `uTopColor` しか無い）ため、
 * テクスチャで光らせることもできない。灯火は形として持ち、明るさは
 * `MeshCommand.color` の乗算で作る — トンネルの灯具（`build-tunnel-mesh.mjs`）と同じ作法。
 *
 * ## 位置の決め方
 *
 * 後端の帯（全長の `band`）にある**後ろ向きの面**（法線 X > 0.5）だけを見る。
 * その中で左右位置が `inner`〜`outer`（半車幅に対する割合）に入る頂点を集め、
 * 高さの中央値を灯火の高さにする。板は車体の局所 X の最大値から `offset` だけ
 * 押し出して置く（第4世代は深度バッファがあるので、面の上に載せると Z ファイトする）。
 *
 * 第4世代のテクスチャの赤から採らないのは、**赤い画素が左右対称に並んでいない**ため。
 * 実測では後端に 23 三角形が見つかるが、側面の飾りにも散っていて左右で数も位置も違う。
 *
 * ## テクスチャ
 *
 * 板が引くのは**塗装テクスチャの明るい無彩色テクセル 1 点**だけである。灯火の色は
 * 実行時の乗算 1 つで決まるので、テクスチャを増やさずに済む。周囲 3×3 が同じ明るさの
 * 場所を選ぶので、線形補間の世代（第4世代）でも隣が混ざらない。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import {
  CAR_LAMP_SHAPE,
  CAR_MODELS,
  carLampsFor,
  carTextureFor,
} from '../src/game/view/shared/car-model.ts';
import { encodeGlb } from './lib/glb.mjs';
import { decodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 明るいテクセルを探すときの「無彩色」の上限。`build-car-paint.mjs` と同じ値 */
const NEUTRAL_SATURATION = 0.22;
/** 選んだテクセルの明るさの下限。ここを割ると灯火が暗くて点いて見えない */
const MIN_TEXEL_VALUE = 0.8;

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;

/** 1 メッシュ 1 プリミティブの GLB を読む（`tools/lib/glb.mjs` が書いた形と、変換器の出力） */
function decodeGlb(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('GLB ではない');
  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const chunk = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(chunk.toString('utf8').replace(/[\s\0]+$/, ''));
    else binary = chunk;
    offset += 8 + length;
  }
  const primitive = json.meshes[0].primitives[0];
  const read = (accessorIndex, components) => {
    const accessor = json.accessors[accessorIndex];
    const bufferView = json.bufferViews[accessor.bufferView];
    const start = (bufferView.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
    return new Float32Array(
      binary.buffer.slice(
        binary.byteOffset + start,
        binary.byteOffset + start + accessor.count * components * 4,
      ),
    );
  };
  return {
    positions: read(primitive.attributes.POSITION, 3),
    normals: read(primitive.attributes.NORMAL, 3),
  };
}

/** 塗装テクスチャの中で「周囲 3×3 まで明るい無彩色」のテクセルを 1 点選ぶ */
function findLampTexel(image) {
  const { width, height, pixels } = image;
  const value = (offset) => Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) / 255;
  const saturation = (offset) => {
    const max = Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    const min = Math.min(pixels[offset], pixels[offset + 1], pixels[offset + 2]);
    return max === 0 ? 0 : (max - min) / max;
  };

  let best = null;
  // 走査順は上から下・左から右。同じ明るさが複数あるときは最初のものを採る（決定論）
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      let darkest = 1;
      let neutral = true;
      for (let dy = -1; dy <= 1 && neutral; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const offset = ((y + dy) * width + (x + dx)) * 4;
          if (pixels[offset + 3] < 250 || saturation(offset) > NEUTRAL_SATURATION) {
            neutral = false;
            break;
          }
          darkest = Math.min(darkest, value(offset));
        }
      }
      if (neutral && (!best || darkest > best.value)) best = { x, y, value: darkest };
    }
  }
  if (!best || best.value < MIN_TEXEL_VALUE) {
    throw new Error(`明るい無彩色のテクセルが見つからない（最良 ${best?.value ?? 0}）`);
  }
  // glTF の UV は v = 0 が画像の上端（メッシュのテクスチャは flipY: false で取り込む）
  return { ...best, u: (best.x + 0.5) / width, v: (best.y + 0.5) / height };
}

/** 中央値。偶数個なら下側を採る（決定論） */
function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * 灯火の帯 2 本。左右は z の符号だけが違う。
 *
 * 面は +X を向く。**列ごとに車体表面の X を測り直す**ので、後ろ姿の丸みに沿う
 * （1 つの X に平らな板を置くと外端が車体からはみ出す・`CAR_LAMP_SHAPE.columns`）。
 * 巻き方は面法線が +X になる側を実際に計算して選ぶので、裏返って背面カリングで
 * 消えることが無い。
 */
function buildLamps(model, texel) {
  const { positions, normals } = model;
  const count = positions.length / 3;
  let maxX = -Infinity;
  const bounds = { minY: Infinity, maxY: -Infinity, maxZ: -Infinity };
  for (let vertex = 0; vertex < count; vertex++) {
    maxX = Math.max(maxX, positions[vertex * 3]);
    bounds.minY = Math.min(bounds.minY, positions[vertex * 3 + 1]);
    bounds.maxY = Math.max(bounds.maxY, positions[vertex * 3 + 1]);
    bounds.maxZ = Math.max(bounds.maxZ, Math.abs(positions[vertex * 3 + 2]));
  }
  const length = maxX * 2;
  const halfWidth = bounds.maxZ;
  const inner = CAR_LAMP_SHAPE.inner * halfWidth;
  const outer = CAR_LAMP_SHAPE.outer * halfWidth;

  // 後ろ姿 ＝ 後端の帯にある後ろ向きの面。灯火の左右位置に入るものだけを見る
  const rear = [];
  for (let vertex = 0; vertex < count; vertex++) {
    const x = positions[vertex * 3];
    const z = Math.abs(positions[vertex * 3 + 2]);
    if (x < maxX - CAR_LAMP_SHAPE.band * length) continue;
    if (normals[vertex * 3] < 0.5) continue;
    if (z < inner || z > outer) continue;
    rear.push({ x, y: positions[vertex * 3 + 1], z });
  }
  if (rear.length < 8) throw new Error(`後ろ姿の頂点が足りない（${rear.length}）`);

  const centerY = median(rear.map((vertex) => vertex.y));
  const lo = centerY - CAR_LAMP_SHAPE.halfHeight;
  const hi = centerY + CAR_LAMP_SHAPE.halfHeight;

  /** その左右位置での車体表面の X。近くに頂点が無ければ窓を広げて探す */
  const surfaceAt = (z) => {
    for (let widen = 1; widen <= 6; widen++) {
      const window = CAR_LAMP_SHAPE.sample * widen;
      let surface = -Infinity;
      for (const vertex of rear) {
        if (Math.abs(vertex.z - z) <= window) surface = Math.max(surface, vertex.x);
      }
      if (surface > -Infinity) return surface + CAR_LAMP_SHAPE.offset;
    }
    throw new Error(`|z| = ${z} の表面が測れない`);
  };

  const columns = Array.from({ length: CAR_LAMP_SHAPE.columns + 1 }, (_unused, index) => {
    const z = inner + ((outer - inner) * index) / CAR_LAMP_SHAPE.columns;
    return { z, x: surfaceAt(z) };
  });

  const positionsOut = [];
  const indices = [];
  for (const side of [-1, 1]) {
    const base = positionsOut.length / 3;
    for (const column of columns) {
      positionsOut.push(column.x, lo, side * column.z);
      positionsOut.push(column.x, hi, side * column.z);
    }
    for (let column = 0; column < CAR_LAMP_SHAPE.columns; column++) {
      const a = base + column * 2;
      const quad = [a, a + 2, a + 3, a, a + 3, a + 1];
      // 面法線が +X を向く巻き方を選ぶ（(b−a)×(c−a) の X 成分の符号で決まる）
      const at = (index) => positionsOut.slice(index * 3, index * 3 + 3);
      const [p0, p1, p2] = [at(quad[0]), at(quad[1]), at(quad[2])];
      const cross =
        (p1[1] - p0[1]) * (p2[2] - p0[2]) - (p1[2] - p0[2]) * (p2[1] - p0[1]);
      indices.push(...(cross > 0 ? quad : [quad[0], quad[2], quad[1], quad[3], quad[5], quad[4]]));
    }
  }

  const vertexCount = positionsOut.length / 3;
  return {
    positions: Float32Array.from(positionsOut),
    // 灯火は `diffuse: 0` のマテリアルで描くので陰影には効かないが、
    // 「後ろを向いた板」であることは形として残す
    normals: Float32Array.from(Array.from({ length: vertexCount }, () => [1, 0, 0]).flat()),
    uvs: Float32Array.from(
      Array.from({ length: vertexCount }, () => [texel.u, texel.v]).flat(),
    ),
    indices: Uint16Array.from(indices),
    centerY,
    columns,
    inner,
    outer,
  };
}

for (const generation of GENERATION_IDS) {
  const lamps = carLampsFor(generation);
  const model = CAR_MODELS[generation];
  if (!lamps || !model) continue;

  const body = decodeGlb(readFileSync(join(repoRoot, 'public', model.asset)));
  const paint = decodePng(readFileSync(join(repoRoot, 'public', carTextureFor(generation))));
  const texel = findLampTexel(paint);
  const mesh = buildLamps(body, texel);

  const glb = encodeGlb({
    positions: mesh.positions,
    normals: mesh.normals,
    uvs: mesh.uvs,
    indices: mesh.indices,
    name: `car-lamps-${generation}`,
  });
  const path = join(repoRoot, 'public', lamps.asset);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, glb);

  console.log(`[${generation}] ${lamps.asset} ${glb.length} B`);
  console.log(
    `  テクセル (${texel.x}, ${texel.y}) 明るさ ${texel.value.toFixed(3)} → ` +
      `uv ${texel.u.toFixed(5)}, ${texel.v.toFixed(5)}`,
  );
  console.log(
    `  帯: 高さ ${mesh.centerY.toFixed(4)} ± ${CAR_LAMP_SHAPE.halfHeight} / ` +
      `|z| ${mesh.inner.toFixed(4)}〜${mesh.outer.toFixed(4)} / ` +
      `表面 x ${mesh.columns.map((column) => column.x.toFixed(4)).join(' ')}`,
  );
}
