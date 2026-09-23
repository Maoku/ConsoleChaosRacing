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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/**
 * 車輪を焼き分ける回転位相の数（実装計画 フェーズ 12-7）。
 *
 * 実行時の `TransformCommand` は `rotationY` と等方 scale しか持たないので、
 * **車軸（横軸）まわりの回転は実行時には作れない**。位相を焼いた車輪 GLB を
 * `WHEEL_PHASES` 枚用意し、フレームごとに `MeshCommand.asset` を差し替えて回す。
 *
 * スキン（`SkinnedMeshCommand`）を使わないのは、レンダラーのスキン経路が
 * マテリアルを読まないためである（`uEnvironmentStrength: 0`・`uAmbient` は
 * 0.45 固定・`uAlphaCutoff: 0`）。第4世代でタイヤだけ映り込みも陰影も
 * 車体と別系統になってしまう。位相を焼けば通常のメッシュ経路に乗り、
 * 車体とまったく同じマテリアルで描ける。
 *
 * 8 枚 ＝ 45° 刻み。表示は 30Hz にラッチされているので（`DisplayLatch`）、
 * 実速度ではこれより 1 フレームの進みのほうが大きい。
 */
const WHEEL_PHASES = 8;

const COMPONENT_ARRAYS = {
  5121: Uint8Array,
  5123: Uint16Array,
  5125: Uint32Array,
  5126: Float32Array,
};
const COMPONENT_COUNTS = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };

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
 * accessor をそのままの型で取り出す（tightly packed 前提）。
 * `readVec3` と違い中身は加工しない — 部分集合を切り出すときの元データになる。
 */
function readAccessor(json, binary, accessorIndex, expectedType) {
  const accessor = json.accessors[accessorIndex];
  if (accessor.sparse) throw new Error('スパースアクセサは非対応');
  if (accessor.type !== expectedType) throw new Error(`${expectedType} ではない accessor`);
  const view = json.bufferViews[accessor.bufferView];
  if (view.byteStride !== undefined) throw new Error('byteStride つきの bufferView は非対応');
  const Ctor = COMPONENT_ARRAYS[accessor.componentType];
  if (!Ctor) throw new Error(`未対応の componentType: ${accessor.componentType}`);
  const components = COMPONENT_COUNTS[accessor.type];
  const start = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0);
  const length = accessor.count * components * Ctor.BYTES_PER_ELEMENT;
  return new Ctor(binary.buffer.slice(binary.byteOffset + start, binary.byteOffset + start + length));
}

/**
 * 位置で溶接した頂点の連結成分。**タイヤはこれで車体から切り離せる。**
 *
 * Tripo の出力は 1 メッシュ 1 プリミティブだが、タイヤは車体と面を共有しない
 * 独立した殻として入っている（実測: 第3世代 4 個・第4世代 6 個）。UV の継ぎ目で
 * 頂点が複製されているので、**位置で溶接してから**辿らないと 1 つの殻が割れる。
 */
function connectedComponents(positions, indices) {
  const count = positions.length / 3;
  const parent = new Int32Array(count);
  const welded = new Map();
  for (let vertex = 0; vertex < count; vertex++) {
    // Float32 の値をそのまま鍵にする。丸めを挟むと溶接の結果が閾値依存になる
    const key = `${positions[vertex * 3]},${positions[vertex * 3 + 1]},${positions[vertex * 3 + 2]}`;
    const first = welded.get(key);
    if (first === undefined) {
      welded.set(key, vertex);
      parent[vertex] = vertex;
    } else {
      parent[vertex] = first;
    }
  }
  const find = (start) => {
    let index = start;
    while (parent[index] !== index) {
      parent[index] = parent[parent[index]];
      index = parent[index];
    }
    return index;
  };
  const union = (a, b) => {
    const rootA = find(a);
    const rootB = find(b);
    if (rootA !== rootB) parent[rootB] = rootA;
  };
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    union(indices[triangle], indices[triangle + 1]);
    union(indices[triangle], indices[triangle + 2]);
  }

  const label = new Int32Array(count);
  const roots = new Map();
  for (let vertex = 0; vertex < count; vertex++) {
    const root = find(vertex);
    let id = roots.get(root);
    if (id === undefined) {
      id = roots.size;
      roots.set(root, id);
    }
    label[vertex] = id;
  }
  return { label, count: roots.size };
}

/**
 * 連結成分のうち「四隅のタイヤ」を選ぶ規則（フェーズ 12-7）。
 *
 * **形と位置だけで選ぶ。** 頂点数や成分の順番に頼ると、モデルを差し替えた
 * 瞬間に静かに壊れる。実測では第4世代の後輪だけがタイヤとリムの 2 殻に
 * 分かれているので、**隅ごとにまとめてから** 1 本の車輪として扱う。
 */
const WHEEL_RULE = {
  /** 重心が車体の下半分にあること */
  centerY: 0,
  /** 重心の |z| が半車幅のこの割合より外にあること */
  centerZ: 0.25,
  /** 重心の |x| が半車長のこの割合より外にあること */
  centerX: 0.15,
  /**
   * 変換元の空間で測った XY のアスペクト比の上限（＝丸いこと）。
   * 実測ではタイヤが 1.02〜1.04、いちばん紛らわしい成分（第4世代の後端の
   * 小さな殻）が 1.33 なので、1.2 で分かれる。
   */
  aspect: 1.2,
  /**
   * 車高に対する上下の大きさの下限（＝大きいこと）。
   *
   * **丸くて小さい殻が車体にはいくつもある。** 第4世代の鼻先には丸い導風口が
   * 左右にあり、位置も形もタイヤの条件を満たしてしまう（実測 0.027 ＝ 車高の 6 %）。
   * タイヤは 0.200〜0.242 ＝ 車高の 44〜53 % あるので、0.35 で確実に分かれる。
   */
  height: 0.35,
  /** 車輪の半径が 4 本で揃っていること（相対差の上限） */
  radiusSpread: 0.12,
};

/** 四隅の並び。**この順で焼く** — 記録の `axles` と 1 対 1 に対応する */
const WHEEL_CORNERS = [
  [-1, -1],
  [-1, 1],
  [1, -1],
  [1, 1],
];

/**
 * 四隅のタイヤを見つけ、車軸の中心と半径を実測する。
 *
 * 車軸は局所 Z に平行（車の前方は -X・上は +Y）。回転はこの軸まわりに掛ける。
 */
function findWheels(positions, indices, bounds, scales) {
  const { label, count } = connectedComponents(positions, indices);
  const parts = Array.from({ length: count }, () => ({
    vertices: [],
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  }));
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const part = parts[label[vertex]];
    part.vertices.push(vertex);
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[vertex * 3 + axis];
      if (value < part.min[axis]) part.min[axis] = value;
      if (value > part.max[axis]) part.max[axis] = value;
    }
  }

  const halfLength = bounds.size[0] / 2;
  const halfWidth = bounds.size[2] / 2;
  const corners = new Map();
  for (const part of parts) {
    const center = [0, 1, 2].map((axis) => (part.min[axis] + part.max[axis]) / 2);
    const size = [0, 1, 2].map((axis) => part.max[axis] - part.min[axis]);
    if (center[1] >= WHEEL_RULE.centerY) continue;
    if (Math.abs(center[2]) < WHEEL_RULE.centerZ * halfWidth) continue;
    if (Math.abs(center[0]) < WHEEL_RULE.centerX * halfLength) continue;
    // 車輪は横（Z）に薄い
    if (size[2] >= size[0] || size[2] >= size[1]) continue;
    if (size[1] < WHEEL_RULE.height * bounds.size[1]) continue;
    // 正規化は前後だけ別倍率なので、**変換元の空間へ戻してから**丸さを見る
    const aspect = (size[0] / scales.longitudinal) / (size[1] / scales.lateral);
    if (aspect > WHEEL_RULE.aspect || aspect < 1 / WHEEL_RULE.aspect) continue;

    const key = `${Math.sign(center[0])},${Math.sign(center[2])}`;
    const corner = corners.get(key) ?? {
      parts: [],
      vertices: [],
      min: [Infinity, Infinity, Infinity],
      max: [-Infinity, -Infinity, -Infinity],
    };
    corner.parts.push(part);
    corner.vertices.push(...part.vertices);
    for (let axis = 0; axis < 3; axis++) {
      corner.min[axis] = Math.min(corner.min[axis], part.min[axis]);
      corner.max[axis] = Math.max(corner.max[axis], part.max[axis]);
    }
    corners.set(key, corner);
  }

  /**
   * 車輪の**内側にすっぽり入っている小さな殻**を取り込む。
   *
   * 第4世代の車輪は中心にセンターキャップの殻を別に持っている（実測 9〜12 頂点・
   * 車軸のちょうど真ん中）。大きさの条件では拾えないが、置き去りにすると
   * **回るホイールの真ん中で 1 枚だけ止まった円盤**になる。逆に、はみ出す殻
   * （サスペンションなど）は取り込まない — 完全に内側にあることを条件にする。
   */
  for (const part of parts) {
    if ([...corners.values()].some((corner) => corner.parts.includes(part))) continue;
    for (const corner of corners.values()) {
      const inside = [0, 1, 2].every(
        (axis) => part.min[axis] >= corner.min[axis] && part.max[axis] <= corner.max[axis],
      );
      if (!inside) continue;
      corner.parts.push(part);
      corner.vertices.push(...part.vertices);
      break;
    }
  }

  const wheels = WHEEL_CORNERS.map(([signX, signZ]) => {
    const corner = corners.get(`${signX},${signZ}`);
    if (!corner) throw new Error(`タイヤが見つからない隅: x${signX} z${signZ}`);
    return {
      vertices: corner.vertices,
      // 車軸の中心。回転はこの点まわり（Z 軸に平行な軸）に掛かる
      center: [0, 1, 2].map((axis) => (corner.min[axis] + corner.max[axis]) / 2),
      /** 上下方向の半径。接地しているのはここなので、転がりの半径もこれで測る */
      radius: (corner.max[1] - corner.min[1]) / 2,
    };
  });
  if (corners.size !== 4) throw new Error(`四隅のタイヤが揃わない（${corners.size} 隅）`);

  // 4 本の半径が揃っていること。揃わないなら車体の一部を拾っている
  const radii = wheels.map((wheel) => wheel.radius);
  const spread = (Math.max(...radii) - Math.min(...radii)) / Math.min(...radii);
  if (spread > WHEEL_RULE.radiusSpread) {
    throw new Error(`4 本の半径が揃わない（相対差 ${spread.toFixed(3)}）`);
  }
  // 車が載っているのはタイヤである。最下点がタイヤに無いなら選び損ねている
  const lowest = Math.min(...wheels.map((wheel) => wheel.center[1] - wheel.radius));
  if (Math.abs(lowest - bounds.min[1]) > 1e-6) {
    throw new Error(`最下点がタイヤにない（${lowest} / ${bounds.min[1]}）`);
  }

  // 頂点 → 車輪番号（車体は -1）。三角形はこの表で振り分ける
  const wheelOf = new Int32Array(positions.length / 3).fill(-1);
  wheels.forEach((wheel, index) => {
    for (const vertex of wheel.vertices) wheelOf[vertex] = index;
  });
  return { wheels, wheelOf };
}

/**
 * 車輪を車軸まわりに `radians` だけ回す（位相を焼く）。
 *
 * **正規化で前後だけ 1.10 倍に伸びている**ので、そのまま回すと楕円が首を振る。
 * 変換元の空間（伸ばす前 ＝ 車輪が丸い空間）へ戻して回し、また伸ばす。
 * 円を回してから写した楕円は元の楕円と重なるので、**輪郭がほとんど動かない**。
 *
 * 8 位相ぶんの bounds のぶれ（モデル単位・実測）:
 *
 * | | そのまま回す | 変換元の空間で回す |
 * | --- | --- | --- |
 * | 第3世代 | 0.0160 | **0.0050** |
 * | 第4世代 | 0.0239 | **0.0110** |
 *
 * 残っているぶれは**変換元のモデル自体が真円でない**ぶんで、正規化とは関係が無い。
 * 法線は異方倍率の逆転置で往復させる。
 */
function rollWheel(positions, normals, wheel, radians, scales) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const kLon = scales.longitudinal;
  const kLat = scales.lateral;
  for (const vertex of wheel.vertices) {
    const base = vertex * 3;
    const u = (positions[base] - wheel.center[0]) / kLon;
    const v = (positions[base + 1] - wheel.center[1]) / kLat;
    positions[base] = wheel.center[0] + (u * cos - v * sin) * kLon;
    positions[base + 1] = wheel.center[1] + (u * sin + v * cos) * kLat;

    const nu = normals[base] * kLon;
    const nv = normals[base + 1] * kLat;
    const x = (nu * cos - nv * sin) / kLon;
    const y = (nu * sin + nv * cos) / kLat;
    const z = normals[base + 2];
    const length = Math.hypot(x, y, z);
    if (length > 1e-12) {
      normals[base] = x / length;
      normals[base + 1] = y / length;
      normals[base + 2] = z / length;
    }
  }
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
 * 中身と `count` は差し替えるので、min/max も書き直す。
 *
 * 出力は 1 台につき **1 + WHEEL_PHASES 個**になる（フェーズ 12-7）。
 *
 * - `car.glb` … 車体（タイヤを除く）
 * - `car_wheels_<位相>.glb` … 四隅のタイヤだけを、車軸まわりに位相ぶん回したもの
 *
 * 分割は**可逆**である。車体とタイヤ（位相 0）を足すと元の三角形・頂点にちょうど
 * 戻る（`car-conversion.spec.ts` が突き合わせる）ので、記録の `geometry` は
 * 分割前の全体を指したままでよく、`CAR_MODELS.bounds` の意味も変わらない。
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

  const uvs = readAccessor(json, binary, primitive.attributes.TEXCOORD_0, 'VEC2');
  const indices = readAccessor(json, binary, primitive.indices, 'SCALAR');

  const { wheels, wheelOf } = findWheels(packedPositions, indices, bounds, scales);

  // 三角形を車体とタイヤへ振り分ける。1 つの三角形が両方にまたがることは無い
  // （タイヤは面を共有しない独立した殻なので）— またがったら選び方が壊れている
  const bodyTriangles = [];
  const wheelTriangles = [];
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const owner = wheelOf[indices[triangle]];
    for (let corner = 1; corner < 3; corner++) {
      if (wheelOf[indices[triangle + corner]] !== owner) {
        throw new Error('車体とタイヤにまたがる三角形がある');
      }
    }
    (owner < 0 ? bodyTriangles : wheelTriangles).push(triangle);
  }

  const context = { json, mesh, primitive, positions: packedPositions, normals: packedNormals, uvs, indices };
  const body = packSubset(context, bodyTriangles, packedPositions, packedNormals);
  const phases = [];
  for (let phase = 0; phase < WHEEL_PHASES; phase++) {
    const rolled = Float32Array.from(packedPositions);
    const rolledNormals = Float32Array.from(packedNormals);
    const radians = (phase / WHEEL_PHASES) * Math.PI * 2;
    for (const wheel of wheels) rollWheel(rolled, rolledNormals, wheel, radians, scales);
    phases.push(packSubset(context, wheelTriangles, rolled, rolledNormals));
  }

  return {
    glb: body.glb,
    json: body.json,
    body,
    phases,
    scales,
    wheels: wheels.map((wheel) => ({
      center: wheel.center.map((value) => Number(value)),
      radius: wheel.radius,
    })),
    geometry: {
      triangles: indices.length / 3,
      vertices: packedPositions.length / 3,
      bounds: { min: [...bounds.min], max: [...bounds.max], size: [...bounds.size] },
    },
  };
}

/**
 * 三角形の部分集合を 1 つの GLB へ焼く。
 *
 * 頂点は**使われた順**に詰め直す（決定論のため。集合の反復順に頼らない）。
 * インデックスの componentType は元のまま使うので、部分集合が 16 bit に
 * 収まらなくなったらそこで落とす — 黙って壊れるより良い。
 */
function packSubset(context, triangles, positions, normals) {
  const { json, mesh, primitive, uvs, indices } = context;

  const remap = new Map();
  const outPositions = [];
  const outNormals = [];
  const outUvs = [];
  const outIndices = [];
  for (const triangle of triangles) {
    for (let corner = 0; corner < 3; corner++) {
      const vertex = indices[triangle + corner];
      let mapped = remap.get(vertex);
      if (mapped === undefined) {
        mapped = remap.size;
        remap.set(vertex, mapped);
        outPositions.push(positions[vertex * 3], positions[vertex * 3 + 1], positions[vertex * 3 + 2]);
        outNormals.push(normals[vertex * 3], normals[vertex * 3 + 1], normals[vertex * 3 + 2]);
        outUvs.push(uvs[vertex * 2], uvs[vertex * 2 + 1]);
      }
      outIndices.push(mapped);
    }
  }

  const packedPositions = Float32Array.from(outPositions);
  const packedNormals = Float32Array.from(outNormals);
  const packedUvs = Float32Array.from(outUvs);
  const IndexArray = COMPONENT_ARRAYS[json.accessors[primitive.indices].componentType];
  if (remap.size > 2 ** (IndexArray.BYTES_PER_ELEMENT * 8)) {
    throw new Error('インデックスの型に頂点数が収まらない');
  }
  const packedIndices = IndexArray.from(outIndices);
  const bounds = boundsOf(Float64Array.from(packedPositions));

  const replacements = new Map([
    [primitive.attributes.POSITION, { data: Buffer.from(packedPositions.buffer), bounds, count: remap.size }],
    [primitive.attributes.NORMAL, { data: Buffer.from(packedNormals.buffer), bounds: null, count: remap.size }],
    [primitive.attributes.TEXCOORD_0, { data: Buffer.from(packedUvs.buffer), bounds: null, count: remap.size }],
    [primitive.indices, { data: Buffer.from(packedIndices.buffer), bounds: null, count: packedIndices.length }],
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
    const data = replacement.data;
    if (packedOffset % 4 !== 0) throw new Error('bufferView の詰め直しで 4 バイト境界を割った');

    const view = { ...sourceView, byteOffset: packedOffset, byteLength: data.length };
    accessor.count = replacement.count;
    if (replacement.bounds) {
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

  return {
    glb: writeGlb(converted, packed),
    json: converted,
    triangles: packedIndices.length / 3,
    vertices: remap.size,
    bounds,
  };
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

/** 車輪 GLB の置き場所。車体と同じディレクトリに位相ぶん並べる */
function wheelPathFor(modelPath, phase) {
  return modelPath.replace(/car\.glb$/, `car_wheels_${phase}.glb`);
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
  const geometry = converted.geometry;
  const texture = convertTexture(source, entry.runtime.texture.dimensions);
  const wheelPaths = converted.phases.map((_unused, phase) =>
    wheelPathFor(entry.runtime.model.path, phase),
  );

  const modelIdentical = Buffer.compare(converted.glb, readFileSync(modelPath)) === 0;
  const textureIdentical = Buffer.compare(texture.png, readFileSync(texturePath)) === 0;
  console.log(
    `  車体 GLB ${converted.glb.length} B / ${converted.body.triangles} tri / ${converted.body.vertices} vtx`,
  );
  console.log(
    `  タイヤ GLB ${converted.phases[0].glb.length} B × ${WHEEL_PHASES} 位相 / ` +
      `${converted.phases[0].triangles} tri / ${converted.phases[0].vertices} vtx / ` +
      `半径 ${converted.wheels[0].radius.toFixed(6)}`,
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

  // 車輪も 1 枚ずつ現物と突き合わせる（記録がまだ無いときは書き出しに任せる）
  if (entry.runtime.wheels) {
    if (entry.runtime.wheels.phases !== WHEEL_PHASES) {
      console.error(`  位相の数が記録と違う: ${WHEEL_PHASES} / ${entry.runtime.wheels.phases}`);
      failures += 1;
    }
    converted.phases.forEach((phase, index) => {
      const path = join(repoRoot, wheelPaths[index]);
      if (!existsSync(path) || Buffer.compare(phase.glb, readFileSync(path)) !== 0) {
        console.error(`  現物と車輪 GLB が不一致: ${wheelPaths[index]}`);
        failures += 1;
      }
    });
  }

  // 二度目の変換が 1 度目と一致すること（決定論）
  const againSource = readGlb(sourcePath);
  const again = convertCar(againSource, entry.normalize);
  if (Buffer.compare(converted.glb, again.glb) !== 0) {
    console.error('  2 回目の変換が 1 回目と一致しない（GLB）');
    failures += 1;
  }
  for (let phase = 0; phase < WHEEL_PHASES; phase++) {
    if (Buffer.compare(converted.phases[phase].glb, again.phases[phase].glb) !== 0) {
      console.error(`  2 回目の変換が 1 回目と一致しない（車輪 ${phase}）`);
      failures += 1;
    }
  }
  const againTexture = convertTexture(againSource, entry.runtime.texture.dimensions);
  if (Buffer.compare(texture.png, againTexture.png) !== 0) {
    console.error('  2 回目の変換が 1 回目と一致しない（テクスチャ）');
    failures += 1;
  }

  // 分割は可逆。車体 ＋ タイヤ（位相 0）が分割前の全体に戻る
  const splitTriangles = converted.body.triangles + converted.phases[0].triangles;
  const splitVertices = converted.body.vertices + converted.phases[0].vertices;
  if (splitTriangles !== geometry.triangles || splitVertices !== geometry.vertices) {
    console.error(
      `  分割で三角形か頂点が増減した: ${splitTriangles} tri / ${splitVertices} vtx`,
    );
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

  rebuilt.push({ entry, converted, geometry, texture, wheelPaths });
}

if (shouldWrite) {
  for (const { entry, converted, geometry, texture, wheelPaths } of rebuilt) {
    const modelPath = join(repoRoot, entry.runtime.model.path);
    const texturePath = join(repoRoot, entry.runtime.texture.path);
    mkdirSync(dirname(modelPath), { recursive: true });
    mkdirSync(dirname(texturePath), { recursive: true });

    writeFileSync(modelPath, converted.glb);
    entry.runtime.model.sha256 = sha256(converted.glb);
    entry.runtime.model.bytes = converted.glb.length;
    entry.runtime.model.triangles = converted.body.triangles;
    entry.runtime.model.vertices = converted.body.vertices;

    // 車輪。位相ぶんの成果物と、実測した車軸（`car-model.ts` が写す）を記録する
    entry.runtime.wheels = {
      phases: WHEEL_PHASES,
      triangles: converted.phases[0].triangles,
      vertices: converted.phases[0].vertices,
      radius: converted.wheels[0].radius,
      axles: converted.wheels.map((wheel) => wheel.center),
      files: converted.phases.map((phase, index) => {
        const path = join(repoRoot, wheelPaths[index]);
        writeFileSync(path, phase.glb);
        return { path: wheelPaths[index], sha256: sha256(phase.glb), bytes: phase.glb.length };
      }),
    };

    writeFileSync(texturePath, texture.png);
    entry.runtime.texture.sha256 = sha256(texture.png);
    entry.runtime.texture.bytes = texture.png.length;

    entry.geometry.triangles = geometry.triangles;
    entry.geometry.vertices = geometry.vertices;
    entry.geometry.bounds = geometry.bounds;
    console.log(
      `  書き出し: ${entry.runtime.model.path} / 車輪 ${WHEEL_PHASES} 枚 / ${entry.runtime.texture.path}`,
    );
  }
  writeFileSync(recordPath, `${JSON.stringify(record, null, 2)}\n`);
  console.log('car-conversion.json を書き直した');
}

if (failures > 0) {
  console.error(`\nprepare:cars 失敗（${failures} 件）`);
  process.exit(1);
}
console.log('\nprepare:cars 通過');
