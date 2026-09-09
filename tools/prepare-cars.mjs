#!/usr/bin/env node
/**
 * `data/*.glb` → runtime GLB ＋ base color の決定論的な再変換
 * （実装計画 §2.6 / 決定事項 §9-3・車モデル入れ替え計画 §4.2）。
 *
 *   npm run prepare:cars          # 再変換して現物と照合する（既定は書き込まない）
 *   npm run prepare:cars -- --write   # 実際に書き出す
 *
 * `data/README.md` の変換規則をそのまま実行する。
 *
 * - 入力の `data/gen{3,4}_car_tripo.glb` は**絶対に上書きしない**
 * - **正規化を焼き込む**（回転・中心合わせ・寸法合わせ）。実行時の `TransformCommand` は
 *   `rotationY` と等方 scale しか持たないので、変換元の姿勢と寸法はここで直す。
 *   node の TRS へ逃がすと accessor の min/max が実際の姿勢と食い違い、
 *   `CAR_MODELS.bounds` の意味が壊れる
 * - POSITION / NORMAL / TEXCOORD_0 / indices と三角形数を保存する（**bounds は変わる**）
 * - material / image / 未使用属性を除去する
 * - 埋め込みの base color（JPEG）を復号して runtime テクスチャへ焼き直す
 * - 二度連続実行してバイト一致する
 *
 * 正規化の定数（ヨー・目標寸法）は `public/assets/car-conversion.json` の `normalize` に
 * 書いてある。**実行時に探索はしない** — 1 回だけ実測して定数化する、という作法に従う。
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeJpeg } from './lib/jpeg.mjs';
import { decodePng, downscaleBox, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shouldWrite = process.argv.includes('--write');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;

/** runtime GLB に残す頂点属性。この順で accessors へ並べ直す */
const KEPT_ATTRIBUTES = ['POSITION', 'NORMAL', 'TEXCOORD_0'];

const GENERATOR = 'Console Chaos Racing deterministic car converter';

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function padTo4(length) {
  return (4 - (length % 4)) % 4;
}

function readGlb(absolutePath) {
  const bytes = readFileSync(absolutePath);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error(`GLB ではない: ${absolutePath}`);

  let offset = 12;
  let json = null;
  let binary = null;
  while (offset < bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString('utf8').replace(/[\s\0]+$/, ''));
    else if (type === CHUNK_BIN) binary = data;
    offset += 8 + length + padTo4(length);
  }
  if (!json || !binary) throw new Error(`GLB のチャンクが足りない: ${absolutePath}`);
  return { json, binary };
}

function writeGlb(json, binary) {
  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonChunk = Buffer.concat([jsonText, Buffer.alloc(padTo4(jsonText.length), 0x20)]);
  const binChunk = Buffer.concat([binary, Buffer.alloc(padTo4(binary.length), 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(GLB_MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);
  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binChunk.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);

  return Buffer.concat([header, jsonHeader, jsonChunk, binHeader, binChunk]);
}

function sliceView(binary, bufferView) {
  const start = bufferView.byteOffset ?? 0;
  return binary.subarray(start, start + bufferView.byteLength);
}

/** accessor の実体を Float64Array で取り出す（VEC3 前提・計算はすべて倍精度で行う） */
function readVec3(json, binary, accessorIndex) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.type !== 'VEC3') throw new Error('VEC3 ではない accessor');
  if (accessor.componentType !== FLOAT) throw new Error('float 以外の VEC3 は非対応');
  const view = json.bufferViews[accessor.bufferView];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const source = new Float32Array(
    binary.buffer.slice(binary.byteOffset + start, binary.byteOffset + start + accessor.count * 12),
  );
  return Float64Array.from(source);
}

/**
 * `rotationY(θ)`（`car-model.ts` と同じ列優先 mat4 の向き）。
 * 局所ベクトル (x, y, z) を (x·cosθ + z·sinθ, y, −x·sinθ + z·cosθ) へ写す。
 */
function rotateY(values, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  for (let index = 0; index < values.length; index += 3) {
    const x = values[index];
    const z = values[index + 2];
    values[index] = x * cos + z * sin;
    values[index + 2] = -x * sin + z * cos;
  }
}

function boundsOf(values) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < values.length; index += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = values[index + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }
  return { min, max, size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]] };
}

/**
 * 姿勢と寸法の正規化（車モデル入れ替え計画 §4.2）。
 *
 * 1. ヨーを戻す ＋ 前方を `-X` へ。`normalize.yawDegrees` は「対称面の法線を X 軸へ
 *    合わせる回転」なので、そこからさらに −90° 回すと鼻先 `+Z` が `−X` へ来る
 * 2. bounds の中心を原点へ。素のモデルは底面が Y = 0（接地基準）なので、
 *    ここを飛ばすと `carGroundOffset` が 0 になり車が路面へ埋まる
 * 3. 左右（Z）と上下（Y）は 1 つの倍率、前後（X）だけ別の倍率。
 *    相似に縮めると全長が 3.8 m になり、**見た目より先に当たる**車になる（D-4）
 * 4. 法線は回転を掛けたあと、異方倍率の逆転置で正規化し直す
 *
 * `lengthPerWidth` を記録から消すと前後も `kLat` になる ＝ 相似縮小へ落ちる（§7 リスク 2）。
 */
function normalizeGeometry(positions, normals, normalize) {
  const radians = ((normalize.yawDegrees - 90) * Math.PI) / 180;
  rotateY(positions, radians);
  rotateY(normals, radians);

  const rotated = boundsOf(positions);
  const center = [
    (rotated.min[0] + rotated.max[0]) / 2,
    (rotated.min[1] + rotated.max[1]) / 2,
    (rotated.min[2] + rotated.max[2]) / 2,
  ];

  const lateral = normalize.targetWidth / rotated.size[2];
  const longitudinal =
    normalize.lengthPerWidth === undefined
      ? lateral
      : (normalize.targetWidth * normalize.lengthPerWidth) / rotated.size[0];

  for (let index = 0; index < positions.length; index += 3) {
    positions[index] = (positions[index] - center[0]) * longitudinal;
    positions[index + 1] = (positions[index + 1] - center[1]) * lateral;
    positions[index + 2] = (positions[index + 2] - center[2]) * lateral;
  }

  // 異方倍率のもとで法線を保つのは逆転置 diag(1/kLon, 1/kLat, 1/kLat)
  for (let index = 0; index < normals.length; index += 3) {
    const x = normals[index] / longitudinal;
    const y = normals[index + 1] / lateral;
    const z = normals[index + 2] / lateral;
    const length = Math.hypot(x, y, z);
    if (length > 1e-12) {
      normals[index] = x / length;
      normals[index + 1] = y / length;
      normals[index + 2] = z / length;
    } else {
      normals[index] = 0;
      normals[index + 1] = 1;
      normals[index + 2] = 0;
    }
  }

  return { longitudinal, lateral };
}

/**
 * 1 台ぶんの変換。
 *
 * accessors と bufferViews は**元の要素をそのまま持ち回り**、参照する番号だけを
 * 詰め直す。キーの並びが元の出力ツールごとに違う（Blender は `bufferView` が先、
 * meshy は `count` が先）ため、作り直すと JSON のバイト列が変わってしまう。
 * POSITION / NORMAL だけは中身を差し替えるので、min/max も書き直す。
 */
function convertCar(source, normalize) {
  const { json, binary } = source;

  if (json.meshes?.length !== 1) throw new Error('メッシュがちょうど 1 つでない');
  const mesh = json.meshes[0];
  if (mesh.primitives?.length !== 1) throw new Error('プリミティブがちょうど 1 つでない');
  const primitive = mesh.primitives[0];
  if ((primitive.mode ?? 4) !== 4) throw new Error('TRIANGLES 以外は非対応');
  if (primitive.indices === undefined) throw new Error('インデックスの無いプリミティブ');

  // 正規化は倍精度で通し、Float32 へ落とすのは最後の 1 回だけにする
  const positions = readVec3(json, binary, primitive.attributes.POSITION);
  const normals = readVec3(json, binary, primitive.attributes.NORMAL);
  const scales = normalizeGeometry(positions, normals, normalize);
  const packedPositions = Float32Array.from(positions);
  const packedNormals = Float32Array.from(normals);
  // min/max は **Float32 へ落としたあとの値**から採る。ここを倍精度のまま書くと
  // 記録の bounds と現物の頂点が最後の桁で食い違う
  const bounds = boundsOf(Float64Array.from(packedPositions));

  const replacements = new Map([
    [primitive.attributes.POSITION, { data: Buffer.from(packedPositions.buffer), bounds }],
    [primitive.attributes.NORMAL, { data: Buffer.from(packedNormals.buffer), bounds: null }],
  ]);

  // 残す accessor を「属性の順 → インデックス」で並べる
  const keptAccessors = [];
  const attributes = {};
  for (const name of KEPT_ATTRIBUTES) {
    const accessorIndex = primitive.attributes[name];
    if (accessorIndex === undefined) throw new Error(`${name} が無い`);
    attributes[name] = keptAccessors.length;
    keptAccessors.push(accessorIndex);
  }
  const indicesSlot = keptAccessors.length;
  keptAccessors.push(primitive.indices);

  // bufferView は accessor の並び順にそのまま詰める（隙間も padding も入れない）
  const bufferViews = [];
  const chunks = [];
  let packedOffset = 0;
  const accessors = keptAccessors.map((sourceIndex) => {
    const accessor = { ...json.accessors[sourceIndex] };
    if (accessor.sparse) throw new Error('スパースアクセサは非対応');
    const sourceView = json.bufferViews[accessor.bufferView];
    const replacement = replacements.get(sourceIndex);
    const data = replacement ? replacement.data : sliceView(binary, sourceView);
    if (packedOffset % 4 !== 0) throw new Error('bufferView の詰め直しで 4 バイト境界を割った');

    const view = { ...sourceView, byteOffset: packedOffset, byteLength: data.length };
    if (replacement?.bounds) {
      accessor.min = [...replacement.bounds.min];
      accessor.max = [...replacement.bounds.max];
    }
    accessor.bufferView = bufferViews.length;
    bufferViews.push(view);
    chunks.push(data);
    packedOffset += data.length;
    return accessor;
  });

  const packed = Buffer.concat(chunks);

  const converted = {
    asset: { version: '2.0', generator: GENERATOR },
    scene: json.scene ?? 0,
    scenes: json.scenes,
    // 単位行列の `node.matrix` は暗黙の TRS へ正規化する（エンジンは matrix を拒否する）
    nodes: json.nodes.map((node) => normalizeNode(node)),
    meshes: [
      {
        ...(mesh.name === undefined ? {} : { name: mesh.name }),
        primitives: [{ attributes, indices: indicesSlot, mode: 4 }],
      },
    ],
    accessors,
    bufferViews,
    buffers: [{ byteLength: packed.length }],
  };

  return { glb: writeGlb(converted, packed), json: converted, binary: packed, scales };
}

function normalizeNode(node) {
  const { matrix, ...rest } = node;
  if (matrix !== undefined && !isIdentityMatrix(matrix)) {
    throw new Error('単位行列以外の node.matrix は正規化できない');
  }
  return rest;
}

function isIdentityMatrix(matrix) {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  return matrix.length === 16 && matrix.every((value, index) => value === identity[index]);
}

/**
 * 変換元に埋め込まれた base color を runtime テクスチャへ焼き直す。
 *
 * Tripo の出力は JPEG しか持たないので、`lib/jpeg.mjs` で復号し、
 * 記録の `dimensions` へ整数倍のボックス縮小を掛けて PNG で書き出す。
 * PS1 の 256² は世代らしさの一部なので、解像度は現行のまま据え置く（D-7）。
 */
function convertTexture(source, dimensions) {
  const { json, binary } = source;
  if (json.images?.length !== 1) throw new Error('画像がちょうど 1 つでない');
  const image = json.images[0];
  if (image.bufferView === undefined) throw new Error('外部参照の画像は非対応');
  const data = sliceView(binary, json.bufferViews[image.bufferView]);

  const decoded =
    image.mimeType === 'image/jpeg'
      ? decodeJpeg(data)
      : image.mimeType === 'image/png'
        ? decodePng(data)
        : (() => {
            throw new Error(`未対応の画像形式: ${image.mimeType}`);
          })();

  const [width, height] = dimensions;
  if (width !== height) throw new Error('正方形でないテクスチャは非対応');
  if (decoded.width !== decoded.height) throw new Error('正方形でない元テクスチャは非対応');
  if (decoded.width % width !== 0) {
    throw new Error(`${decoded.width}² を ${width}² へ整数倍で縮小できない`);
  }

  const scaled = decoded.width === width ? decoded : downscaleBox(decoded, decoded.width / width);
  return { png: encodePng(scaled.width, scaled.height, scaled.pixels), source: decoded };
}

function measureGeometry(json) {
  const position = json.accessors[0];
  const indices = json.accessors[3];
  const min = position.min;
  const max = position.max;
  return {
    triangles: indices.count / 3,
    vertices: position.count,
    bounds: {
      min,
      max,
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    },
  };
}

// ─────────────────────────────────────────────────────────────

const recordPath = join(repoRoot, 'public/assets/car-conversion.json');
const record = JSON.parse(readFileSync(recordPath, 'utf8'));

let failures = 0;
const rebuilt = [];

for (const entry of record.records) {
  const sourcePath = join(repoRoot, entry.source.path);
  const modelPath = join(repoRoot, entry.runtime.model.path);
  const texturePath = join(repoRoot, entry.runtime.texture.path);
  console.log(`[${entry.generation}] ${entry.source.path}`);

  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== entry.source.sha256) {
    console.error('  入力の SHA-256 が記録と違う。変換を中止する');
    process.exit(1);
  }

  const source = readGlb(sourcePath);
  const converted = convertCar(source, entry.normalize);
  const geometry = measureGeometry(converted.json);
  const texture = convertTexture(source, entry.runtime.texture.dimensions);

  const modelIdentical = Buffer.compare(converted.glb, readFileSync(modelPath)) === 0;
  const textureIdentical = Buffer.compare(texture.png, readFileSync(texturePath)) === 0;
  console.log(
    `  runtime GLB ${converted.glb.length} B / ${geometry.triangles} tri / ${geometry.vertices} vtx`,
  );
  console.log(
    `  正規化: 前後 ×${converted.scales.longitudinal.toFixed(4)} / ` +
      `左右・上下 ×${converted.scales.lateral.toFixed(4)} → ` +
      `${geometry.bounds.size.map((value) => value.toFixed(6)).join(' × ')}`,
  );
  console.log(
    `  base color ${texture.source.width}² → ${entry.runtime.texture.dimensions[0]}² ` +
      `/ ${texture.png.length} B`,
  );
  console.log(`  現物と GLB ${modelIdentical ? '一致' : '不一致'} / テクスチャ ${textureIdentical ? '一致' : '不一致'}`);
  if (!modelIdentical) failures += 1;
  if (!textureIdentical) failures += 1;

  // 二度目の変換が 1 度目と一致すること（決定論）
  const againSource = readGlb(sourcePath);
  const again = convertCar(againSource, entry.normalize);
  if (Buffer.compare(converted.glb, again.glb) !== 0) {
    console.error('  2 回目の変換が 1 回目と一致しない（GLB）');
    failures += 1;
  }
  const againTexture = convertTexture(againSource, entry.runtime.texture.dimensions);
  if (Buffer.compare(texture.png, againTexture.png) !== 0) {
    console.error('  2 回目の変換が 1 回目と一致しない（テクスチャ）');
    failures += 1;
  }

  if (geometry.triangles !== entry.geometry.triangles) {
    console.error(`  三角形数が記録と違う: ${geometry.triangles} / ${entry.geometry.triangles}`);
    failures += 1;
  }
  if (geometry.vertices !== entry.geometry.vertices) {
    console.error(`  頂点数が記録と違う: ${geometry.vertices} / ${entry.geometry.vertices}`);
    failures += 1;
  }
  for (const axis of [0, 1, 2]) {
    if (geometry.bounds.min[axis] !== entry.geometry.bounds.min[axis]) {
      console.error(`  bounds.min[${axis}] が記録と違う`);
      failures += 1;
    }
    if (geometry.bounds.max[axis] !== entry.geometry.bounds.max[axis]) {
      console.error(`  bounds.max[${axis}] が記録と違う`);
      failures += 1;
    }
  }

  rebuilt.push({ entry, converted, geometry, texture });
}

if (shouldWrite) {
  for (const { entry, converted, geometry, texture } of rebuilt) {
    const modelPath = join(repoRoot, entry.runtime.model.path);
    const texturePath = join(repoRoot, entry.runtime.texture.path);
    mkdirSync(dirname(modelPath), { recursive: true });
    mkdirSync(dirname(texturePath), { recursive: true });

    writeFileSync(modelPath, converted.glb);
    entry.runtime.model.sha256 = sha256(converted.glb);
    entry.runtime.model.bytes = converted.glb.length;

    writeFileSync(texturePath, texture.png);
    entry.runtime.texture.sha256 = sha256(texture.png);
    entry.runtime.texture.bytes = texture.png.length;

    entry.geometry.triangles = geometry.triangles;
    entry.geometry.vertices = geometry.vertices;
    entry.geometry.bounds = geometry.bounds;
    console.log(`  書き出し: ${entry.runtime.model.path} / ${entry.runtime.texture.path}`);
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log('car-conversion.json を書き直した');
}

if (failures > 0) {
  console.error(`\nprepare:cars 失敗（${failures} 件）`);
  process.exit(1);
}
console.log('\nprepare:cars 通過');
