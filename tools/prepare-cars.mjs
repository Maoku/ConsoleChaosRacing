#!/usr/bin/env node
/**
 * `data/*.glb` → runtime GLB の決定論的な再変換（実装計画 §2.6 / 決定事項 §9-3）。
 *
 *   npm run prepare:cars          # 再変換して現物と照合する（既定は書き込まない）
 *   npm run prepare:cars -- --write   # 実際に書き出す
 *
 * `data/README.md` の変換規則をそのまま実行する。
 *
 * - 入力の `data/gen{3,4}_car.glb` は**絶対に上書きしない**
 * - POSITION / NORMAL / TEXCOORD_0 / indices / 三角形数 / bounds を保存する
 * - 未使用の normal・metallic/roughness 画像を除去する
 * - Gen4 の単位行列 `node.matrix` を暗黙の TRS へ正規化する
 * - 二度連続実行してバイト一致する
 *
 * **ベーステクスチャの再生成は行わない。** 元データの base color は 2〜5 MB の
 * PNG / JPEG で、runtime テクスチャはそれを 256² / 1024² へ縮小したものだが、
 * 縮小フィルタと PNG エンコーダの設定まで一致させないとバイト一致しない。
 * このリポジトリは画像コーデックへの依存を持たない方針なので、テクスチャは
 * 「記録済みの成果物」として扱い、`car-conversion.json` との照合だけを行う
 * （照合そのものは `npm run check:cars`）。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const shouldWrite = process.argv.includes('--write');

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

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

/**
 * 1 台ぶんの変換。
 *
 * accessors と bufferViews は**元の要素をそのまま持ち回り**、参照する番号だけを
 * 詰め直す。キーの並びが元の出力ツールごとに違う（Blender は `bufferView` が先、
 * meshy は `count` が先）ため、作り直すと JSON のバイト列が変わってしまう。
 */
function convertCar(source) {
  const { json, binary } = source;

  if (json.meshes?.length !== 1) throw new Error('メッシュがちょうど 1 つでない');
  const mesh = json.meshes[0];
  if (mesh.primitives?.length !== 1) throw new Error('プリミティブがちょうど 1 つでない');
  const primitive = mesh.primitives[0];
  if ((primitive.mode ?? 4) !== 4) throw new Error('TRIANGLES 以外は非対応');
  if (primitive.indices === undefined) throw new Error('インデックスの無いプリミティブ');

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
    const data = sliceView(binary, sourceView);
    if (packedOffset % 4 !== 0) throw new Error('bufferView の詰め直しで 4 バイト境界を割った');

    const view = { ...sourceView, byteOffset: packedOffset };
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

  return { glb: writeGlb(converted, packed), json: converted, binary: packed };
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
  console.log(`[${entry.generation}] ${entry.source.path}`);

  const sourceBytes = readFileSync(sourcePath);
  if (sha256(sourceBytes) !== entry.source.sha256) {
    console.error('  入力の SHA-256 が記録と違う。変換を中止する');
    process.exit(1);
  }

  const source = readGlb(sourcePath);
  const converted = convertCar(source);
  const geometry = measureGeometry(converted.json);
  const current = readFileSync(modelPath);

  const identical = Buffer.compare(converted.glb, current) === 0;
  console.log(
    `  runtime GLB ${converted.glb.length} B / ${geometry.triangles} tri / ${geometry.vertices} vtx`,
  );
  console.log(`  現物と${identical ? '一致' : '不一致'}`);
  if (!identical) failures += 1;

  // 二度目の変換が 1 度目と一致すること（決定論）
  const again = convertCar(readGlb(sourcePath));
  if (Buffer.compare(converted.glb, again.glb) !== 0) {
    console.error('  2 回目の変換が 1 回目と一致しない');
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

  rebuilt.push({ entry, converted, geometry });
}

if (shouldWrite) {
  for (const { entry, converted, geometry } of rebuilt) {
    const modelPath = join(repoRoot, entry.runtime.model.path);
    writeFileSync(modelPath, converted.glb);
    entry.runtime.model.sha256 = sha256(converted.glb);
    entry.runtime.model.bytes = converted.glb.length;
    // `geometry.fingerprint` は「レンダラー正規形」の指紋であり、その正規化の定義が
    // 成果物から復元できない。触らずに元の値を残す（`bytes` と `sha256` で十分に固定できる）
    entry.geometry.triangles = geometry.triangles;
    entry.geometry.vertices = geometry.vertices;
    entry.geometry.bounds = geometry.bounds;
    console.log(`  書き出し: ${entry.runtime.model.path}`);
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log('car-conversion.json を書き直した');
}

if (failures > 0) {
  console.error(`\nprepare:cars 失敗（${failures} 件）`);
  process.exit(1);
}
console.log('\nprepare:cars 通過（テクスチャは check:cars で照合する）');
