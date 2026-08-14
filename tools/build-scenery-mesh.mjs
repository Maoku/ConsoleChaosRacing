#!/usr/bin/env tsx
/**
 * 第4世代のタイヤフェンス メッシュ（実装計画 §2.6 / 8-6 / 8-10）。
 *
 *   npm run build:scenery-mesh
 *
 * 高曲率区間の外側にだけ置く小さなメッシュ。**第3世代には置かない** —
 * ordering table のスロットとドローコールを増やさないためで、
 * 第3世代のタイヤフェンスは看板や木と同じくビルボードにも出さない（8-6 の表）。
 *
 * 形は**段ごとの円柱**（半径 0.183 m ＝ 実車のタイヤ 1 本ぶん）を 3 段。
 * 箱にテクスチャを貼っただけの初版はタイヤに見えなかった（8-10）。
 * UV はコースの路面アトラスの**タイヤの帯**を引くので、テクスチャは増えない。
 * 弧に沿って u を回すため、円柱の側面がそのまま丸く陰る。
 * 実行時は `TransformCommand.rotationY` でコースの接線へ向ける。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TYRE_WALL, tyreRadius } from '../src/game/view/shared/scenery-mesh.ts';
import { TRACK_ATLAS, TRACK_ATLAS_TILES } from '../src/game/view/shared/track-mesh.ts';
import { computeNormals, encodeGlb } from './lib/glb.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 積んだタイヤ。局所座標は **+X が進行方向・+Z が右**（車モデルと同じ規約）で、
 * 原点は接地面の中心に置く。
 *
 * 1 段が 1 つの円柱。角度 φ は +Z から測り、`u` は
 * **側面（φ = 0, π）が帯の中央・上下（φ = ±π/2）が帯の端**になるように回す。
 * 帯はその向きで塗ってある（`build-track-mesh.mjs` の `paintTyres`）ので、
 * コースのどちら側に置いても track 側を向いた面がいちばん明るくなる。
 */
function buildTyreWall() {
  const radius = tyreRadius();
  const half = TYRE_WALL.length / 2;
  const positions = [];
  const uvs = [];
  const indices = [];

  for (let row = 0; row < TYRE_WALL.rows; row++) {
    const centerY = radius + row * radius * 2;
    const base = positions.length / 3;

    for (let facet = 0; facet <= TYRE_WALL.facets; facet++) {
      const angle = -Math.PI + (2 * Math.PI * facet) / TYRE_WALL.facets;
      const y = centerY + radius * Math.sin(angle);
      const z = radius * Math.cos(angle);
      // 帯の中央が側面、端が上下。0.5 - sin/2 は φ を一周しても連続する
      const u =
        TRACK_ATLAS.tyres.bottom +
        (TRACK_ATLAS.tyres.top - TRACK_ATLAS.tyres.bottom) * (0.5 - Math.sin(angle) / 2);
      // v は進行方向の実長。1 タイル 2.8 m にタイヤ 4 本が入る
      for (const x of [-half, half]) {
        positions.push(x, y, z);
        uvs.push(u, (x + half) / TRACK_ATLAS_TILES.tyres);
      }
    }

    // 外を向かせる巻き方。ここは輪の順に頂点を並べているので、
    // 面の法線は「進行方向 × φ の進む向き」になる（コースメッシュとは列と行が逆）
    for (let facet = 0; facet < TYRE_WALL.facets; facet++) {
      const a = base + facet * 2;
      const b = base + facet * 2 + 1;
      const c = base + (facet + 1) * 2 + 1;
      const d = base + (facet + 1) * 2;
      indices.push(a, b, c, a, c, d);
    }
  }

  // 両端の蓋。タイヤの断面が見えるので、いちばん暗い帯の端の色で塞ぐ
  for (const [side, x] of [[-1, -half], [1, half]].entries()) {
    for (let row = 0; row < TYRE_WALL.rows; row++) {
      const centerY = radius + row * radius * 2;
      const base = positions.length / 3;
      positions.push(x, centerY, 0);
      uvs.push(TRACK_ATLAS.tyres.bottom, 0);
      for (let facet = 0; facet <= TYRE_WALL.facets; facet++) {
        const angle = -Math.PI + (2 * Math.PI * facet) / TYRE_WALL.facets;
        positions.push(x, centerY + radius * Math.sin(angle), radius * Math.cos(angle));
        uvs.push(TRACK_ATLAS.tyres.bottom, 0);
      }
      for (let facet = 0; facet < TYRE_WALL.facets; facet++) {
        const a = base;
        const b = base + 1 + facet;
        const c = base + 2 + facet;
        if (side === 0) indices.push(a, b, c);
        else indices.push(a, c, b);
      }
    }
  }

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

const mesh = buildTyreWall();
const relativePath = `public/${TYRE_WALL.asset}`;
const absolute = join(repoRoot, relativePath);
mkdirSync(dirname(absolute), { recursive: true });
const glb = encodeGlb(mesh);
writeFileSync(absolute, glb);

console.log(
  `${relativePath} ${mesh.triangles} tri / ` +
    `${TYRE_WALL.length} m × ${TYRE_WALL.rows} 段（半径 ${tyreRadius().toFixed(3)} m）/ ${glb.length} B`,
);
console.log('背景メッシュ生成 完了');
