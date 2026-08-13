#!/usr/bin/env tsx
/**
 * 第4世代のタイヤフェンス メッシュ（実装計画 §2.6 / 8-6）。
 *
 *   npm run build:scenery-mesh
 *
 * 高曲率区間の外側にだけ置く小さなメッシュ。**第3世代には置かない** —
 * ordering table のスロットとドローコールを増やさないためで、
 * 第3世代のタイヤフェンスは看板や木と同じくビルボードにも出さない（8-6 の表）。
 *
 * 形は 4 m × 1.1 m × 0.9 m の箱で、正面（コース側）にタイヤの列を写す。
 * UV はコースの路面アトラスの**壁の帯**を引くので、テクスチャは増えない。
 * 実行時は `TransformCommand.rotationY` でコースの接線へ向ける。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYRE_WALL } from '../src/game/view/shared/scenery-mesh.ts';
import { computeNormals, encodeGlb } from './lib/glb.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 壁の帯の u。`build-track-mesh.mjs` の `BAND.wallBottom`〜`wallTop` に合わせる */
const U = { bottom: 0.9, top: 0.98 };

/**
 * 箱を 1 つ。局所座標は **+X が進行方向・+Z が右**（車モデルと同じ規約）で、
 * 原点は接地面の中心に置く。
 */
function buildBox(length, height, depth) {
  const halfLength = length / 2;
  const halfDepth = depth / 2;
  const positions = [];
  const uvs = [];
  const indices = [];

  /** 4 点で 1 面。順序は外から見て反時計回り */
  const quad = (a, b, c, d) => {
    const base = positions.length / 3;
    for (const [x, y, z] of [a, b, c, d]) positions.push(x, y, z);
    // 高さで u、長さで v を引く（壁の帯と同じ貼り方）
    for (const [, y, z] of [a, b, c, d]) {
      uvs.push(U.bottom + (U.top - U.bottom) * (y / height), z / 2 + halfDepth);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  };

  const top = height;
  // コース側（-Z）と外側（+Z）
  quad(
    [-halfLength, top, -halfDepth],
    [-halfLength, 0, -halfDepth],
    [halfLength, 0, -halfDepth],
    [halfLength, top, -halfDepth],
  );
  quad(
    [halfLength, top, halfDepth],
    [halfLength, 0, halfDepth],
    [-halfLength, 0, halfDepth],
    [-halfLength, top, halfDepth],
  );
  // 上面
  quad(
    [-halfLength, top, halfDepth],
    [-halfLength, top, -halfDepth],
    [halfLength, top, -halfDepth],
    [halfLength, top, halfDepth],
  );
  // 端（両側）
  quad(
    [-halfLength, top, -halfDepth],
    [-halfLength, top, halfDepth],
    [-halfLength, 0, halfDepth],
    [-halfLength, 0, -halfDepth],
  );
  quad(
    [halfLength, top, halfDepth],
    [halfLength, top, -halfDepth],
    [halfLength, 0, -halfDepth],
    [halfLength, 0, halfDepth],
  );

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint16Array(indices);
  return {
    name: 'tyre-wall',
    positions: positionArray,
    normals: computeNormals(positionArray, indexArray),
    uvs: new Float32Array(uvs),
    indices: indexArray,
    triangles: indexArray.length / 3,
  };
}

const mesh = buildBox(TYRE_WALL.length, TYRE_WALL.height, TYRE_WALL.depth);
const relativePath = `public/${TYRE_WALL.asset}`;
const absolute = join(repoRoot, relativePath);
mkdirSync(dirname(absolute), { recursive: true });
const glb = encodeGlb(mesh);
writeFileSync(absolute, glb);

console.log(
  `${relativePath} ${mesh.triangles} tri / ` +
    `${TYRE_WALL.length}×${TYRE_WALL.height}×${TYRE_WALL.depth} m / ${glb.length} B`,
);
console.log('背景メッシュ生成 完了');
