/**
 * 依存無しの最小 GLB ライタ。
 *
 * エンジンの glTF ローダは意図的なサブセット（TRIANGLES / POSITION・NORMAL・TEXCOORD_0 /
 * インデックス必須 / `node.matrix` 禁止）なので、こちらもその範囲だけを書く。
 * 生成物はリポジトリにコミットするため、**二度実行してバイト一致**することが要件。
 * 浮動小数は Float32Array へ落としてから書き出すので、丸めは決定論的になる。
 */

const MAGIC = 0x46546c67; // 'glTF'
const CHUNK_JSON = 0x4e4f534a;
const CHUNK_BIN = 0x004e4942;

const FLOAT = 5126;
const UNSIGNED_SHORT = 5123;
const UNSIGNED_INT = 5125;
const ARRAY_BUFFER = 34962;
const ELEMENT_ARRAY_BUFFER = 34963;

function padTo4(length) {
  return (4 - (length % 4)) % 4;
}

/**
 * 1 メッシュ 1 プリミティブの GLB を書く。
 *
 * @param {object} mesh
 * @param {Float32Array} mesh.positions 3 成分 × 頂点数
 * @param {Float32Array} mesh.normals   3 成分 × 頂点数
 * @param {Float32Array} mesh.uvs       2 成分 × 頂点数
 * @param {Uint16Array|Uint32Array} mesh.indices
 * @param {string} mesh.name
 * @returns {Buffer}
 */
export function encodeGlb(mesh) {
  const { positions, normals, uvs, indices, name } = mesh;
  const vertexCount = positions.length / 3;
  if (normals.length !== vertexCount * 3) throw new Error('NORMAL の要素数が POSITION と合わない');
  if (uvs.length !== vertexCount * 2) throw new Error('TEXCOORD_0 の要素数が POSITION と合わない');
  if (vertexCount > 65536 && indices instanceof Uint16Array) {
    throw new Error('頂点が 65536 を超えるので Uint32Array のインデックスが要る');
  }

  // POSITION の min/max は glTF 仕様の必須項目
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let index = 0; index < vertexCount; index++) {
    for (let axis = 0; axis < 3; axis++) {
      const value = positions[index * 3 + axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
  }

  const chunks = [
    { data: Buffer.from(positions.buffer, positions.byteOffset, positions.byteLength), target: ARRAY_BUFFER },
    { data: Buffer.from(normals.buffer, normals.byteOffset, normals.byteLength), target: ARRAY_BUFFER },
    { data: Buffer.from(uvs.buffer, uvs.byteOffset, uvs.byteLength), target: ARRAY_BUFFER },
    { data: Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength), target: ELEMENT_ARRAY_BUFFER },
  ];

  const bufferViews = [];
  const parts = [];
  let offset = 0;
  for (const chunk of chunks) {
    // bufferView の byteOffset は成分サイズの倍数でなければならない。4 で揃えれば足りる
    const padding = padTo4(offset);
    if (padding > 0) {
      parts.push(Buffer.alloc(padding));
      offset += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: chunk.data.length, target: chunk.target });
    parts.push(chunk.data);
    offset += chunk.data.length;
  }
  const binary = Buffer.concat(parts);

  const json = {
    asset: { version: '2.0', generator: 'ConsoleChaosRacing tools/lib/glb.mjs' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ name, mesh: 0 }],
    meshes: [
      {
        name,
        primitives: [
          { attributes: { POSITION: 0, NORMAL: 1, TEXCOORD_0: 2 }, indices: 3, mode: 4 },
        ],
      },
    ],
    accessors: [
      { bufferView: 0, componentType: FLOAT, count: vertexCount, type: 'VEC3', min, max },
      { bufferView: 1, componentType: FLOAT, count: vertexCount, type: 'VEC3' },
      { bufferView: 2, componentType: FLOAT, count: vertexCount, type: 'VEC2' },
      {
        bufferView: 3,
        componentType: indices instanceof Uint32Array ? UNSIGNED_INT : UNSIGNED_SHORT,
        count: indices.length,
        type: 'SCALAR',
      },
    ],
    bufferViews,
    buffers: [{ byteLength: binary.length }],
  };

  const jsonText = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadded = Buffer.concat([jsonText, Buffer.alloc(padTo4(jsonText.length), 0x20)]);
  const binPadded = Buffer.concat([binary, Buffer.alloc(padTo4(binary.length), 0)]);

  const header = Buffer.alloc(12);
  header.writeUInt32LE(MAGIC, 0);
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonPadded.length + 8 + binPadded.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonPadded.length, 0);
  jsonHeader.writeUInt32LE(CHUNK_JSON, 4);

  const binHeader = Buffer.alloc(8);
  binHeader.writeUInt32LE(binPadded.length, 0);
  binHeader.writeUInt32LE(CHUNK_BIN, 4);

  return Buffer.concat([header, jsonHeader, jsonPadded, binHeader, binPadded]);
}

/**
 * 三角形リストから頂点法線を求める（面法線の面積重み付き平均）。
 * `positions` を破壊せず、新しい Float32Array を返す。
 */
export function computeNormals(positions, indices) {
  const normals = new Float32Array(positions.length);
  for (let triangle = 0; triangle < indices.length; triangle += 3) {
    const a = indices[triangle] * 3;
    const b = indices[triangle + 1] * 3;
    const c = indices[triangle + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const uz = positions[b + 2] - positions[a + 2];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const vz = positions[c + 2] - positions[a + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    for (const base of [a, b, c]) {
      normals[base] += nx;
      normals[base + 1] += ny;
      normals[base + 2] += nz;
    }
  }
  for (let index = 0; index < normals.length; index += 3) {
    const length = Math.hypot(normals[index], normals[index + 1], normals[index + 2]);
    if (length > 1e-9) {
      normals[index] /= length;
      normals[index + 1] /= length;
      normals[index + 2] /= length;
    } else {
      normals[index + 1] = 1;
    }
  }
  return normals;
}
