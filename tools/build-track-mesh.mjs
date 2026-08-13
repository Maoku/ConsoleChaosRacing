#!/usr/bin/env tsx
/**
 * コース中心線 → 第3・第4世代のコースメッシュ GLB ＋ 路面テクスチャ（実装計画 §2.6 / §3.4）。
 *
 * `src/game/sim/track.ts` を直接 import する。`TransformCommand` の回転が `rotationY` しか
 * 無いため、標高とバンクは**メッシュに焼き込むしかない**。ここで焼く。
 *
 *   npm run build:track
 *
 * セクター分割は `src/game/view/shared/track-mesh.ts` と共有する。生成側と描画側で
 * 切り方がずれると描かない区間ができるので、定義はあちらの 1 か所にある。
 *
 * 断面は 13 点・5 本のストリップで、路面 / 縁石 / 草地を 1 枚のアトラスの
 * 別々の u 帯へ写す。マテリアルはメッシュ 1 つにつき 1 つしか指定できないため、
 * 面ごとにテクスチャを分けるのではなくアトラスにする（当時のテクスチャページと同じ作り）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { TRACK } from '../src/game/sim/track.ts';
import {
  TRACK_MESH_LODS,
  trackSectorAsset,
  trackSurfaceTexture,
} from '../src/game/view/shared/track-mesh.ts';
import { computeNormals, encodeGlb } from './lib/glb.mjs';
import { Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── 断面の寸法 [m]
/** 縁石の幅 */
const CURB_WIDTH = 1.2;
/** 縁石の落差（路面より低い） */
const CURB_DROP = 0.08;
/** 草地の幅（`VEHICLE.RUNOFF` と揃える。ここまでは走れる） */
const GRASS_WIDTH = 9;
/** 草地の外縁の落差 */
const GRASS_DROP = 0.45;
/**
 * 草地の外へ立てる壁の高さ [m]（実装計画 8-6）。
 *
 * **コースメッシュへ焼き込む。** `TransformCommand` に X/Z 回転が無い以上、
 * バンクのついた路面に沿う壁は別メッシュでは置けない（§1.3）。
 * 三角形は 1 セクターあたり第3世代 +388・第4世代 +248 で、どちらも予算の内側。
 */
const WALL_HEIGHT = 1;
/**
 * 壁の外へ張る土手の幅 [m]（実装計画 8-6）。
 *
 * 壁の上端の高さで平らに伸ばす（＝壁は土手を留める擁壁）。**木を植える地面**であり、
 * これが無いと壁の外に置いた木が空の中に浮く（実画面で起きた）。
 * 1 区間あたり四角形 2 つ（左右）＝ 4 三角形しか増えない。
 */
const APRON_WIDTH = 12;

// ── アトラスの u 帯（`buildSurfaceTexture` と一致させる）
const BAND = {
  roadFrom: 0.015,
  roadTo: 0.485,
  curbOuter: 0.515,
  curbInner: 0.685,
  grassOuter: 0.715,
  grassInner: 0.865,
  // 壁は下端が帯の下、上端が帯の上（u が縦に貼られる）
  wallBottom: 0.895,
  wallTop: 0.985,
};

// ── v のタイル長 [m]。路面は破線 1 周期、縁石は縞 1 周期
const TILE = { road: 8, curb: 4, grass: 6, wall: 4 };

/**
 * 断面の 1 点。`lateral` は中心線からの右向き距離、`height` は路面からの高さ。
 * どちらもバンク回転の前の値で、ワールドへ移すときにまとめて回す。
 */
function crossSection(halfWidth, roadSpans) {
  const points = [];
  const push = (lateral, height, u, tile) => points.push({ lateral, height, u, tile });
  const outer = halfWidth + CURB_WIDTH + GRASS_WIDTH;
  const apronHeight = -GRASS_DROP + WALL_HEIGHT;

  // 左の土手。壁の上端の高さで平らに伸ばす。**列は左から右へ**（法線が上を向く向き）
  push(-(outer + APRON_WIDTH), apronHeight, BAND.grassOuter, TILE.grass);
  push(-outer, apronHeight, BAND.grassInner, TILE.grass);

  // 左の壁。**列は上から下へ並べる** — 面の法線は「列の向き × 進行方向」なので、
  // 上から下へ並べたときだけ法線がコース中心（右）を向く。逆にすると裏面カリングで消える
  push(-outer, apronHeight, BAND.wallTop, TILE.wall);
  push(-outer, -GRASS_DROP, BAND.wallBottom, TILE.wall);

  push(-outer, -GRASS_DROP, BAND.grassOuter, TILE.grass);
  push(-(halfWidth + CURB_WIDTH), -CURB_DROP, BAND.grassInner, TILE.grass);
  push(-(halfWidth + CURB_WIDTH), -CURB_DROP, BAND.curbOuter, TILE.curb);
  push(-halfWidth, 0, BAND.curbInner, TILE.curb);
  for (let span = 0; span <= roadSpans; span++) {
    const t = span / roadSpans;
    push(-halfWidth + 2 * halfWidth * t, 0, BAND.roadFrom + (BAND.roadTo - BAND.roadFrom) * t, TILE.road);
  }
  push(halfWidth, 0, BAND.curbInner, TILE.curb);
  push(halfWidth + CURB_WIDTH, -CURB_DROP, BAND.curbOuter, TILE.curb);
  push(halfWidth + CURB_WIDTH, -CURB_DROP, BAND.grassInner, TILE.grass);
  push(outer, -GRASS_DROP, BAND.grassOuter, TILE.grass);

  // 右の壁は逆に、下から上へ（法線がコース中心 ＝ 左を向く）
  push(outer, -GRASS_DROP, BAND.wallBottom, TILE.wall);
  push(outer, apronHeight, BAND.wallTop, TILE.wall);

  // 右の土手
  push(outer, apronHeight, BAND.grassInner, TILE.grass);
  push(outer + APRON_WIDTH, apronHeight, BAND.grassOuter, TILE.grass);

  // 連続して面を張る範囲。境目（同じ位置で u が飛ぶ点）は跨がない
  const road = 8;
  const last = road + roadSpans;
  const strips = [
    [0, 1], // 左の土手
    [2, 3], // 左の壁
    [4, 5], // 左の草地
    [6, 7], // 左の縁石
    [road, last], // 路面
    [last + 1, last + 2], // 右の縁石
    [last + 3, last + 4], // 右の草地
    [last + 5, last + 6], // 右の壁
    [last + 7, last + 8], // 右の土手
  ];
  return { points, strips };
}

/** 断面の 1 点をワールド座標へ。バンクは接線まわりの回転として掛ける */
function toWorldPoint(sample, lateral, height) {
  const bankCos = Math.cos(sample.bank);
  const bankSin = Math.sin(sample.bank);
  const alongRight = lateral * bankCos - height * bankSin;
  const alongUp = lateral * bankSin + height * bankCos;
  return [
    sample.position[0] + sample.right[0] * alongRight,
    sample.position[1] + alongUp,
    sample.position[2] + sample.right[1] * alongRight,
  ];
}

function buildSector(lod, sector) {
  const totalSegments = lod.sectorCount * lod.segmentsPerSector;
  const step = TRACK.length / totalSegments;
  const firstRing = sector * lod.segmentsPerSector;

  const positions = [];
  const uvs = [];
  const indices = [];
  let ringWidth = 0;

  for (let ring = 0; ring <= lod.segmentsPerSector; ring++) {
    const s = (firstRing + ring) * step;
    const sample = TRACK.sampleAt(s);
    const { points, strips } = crossSection(sample.halfWidth, lod.roadSpans);
    ringWidth = points.length;

    for (const point of points) {
      const world = toWorldPoint(sample, point.lateral, point.height);
      positions.push(world[0], world[1], world[2]);
      uvs.push(point.u, s / point.tile);
    }

    if (ring === 0) continue;
    const previous = (ring - 1) * ringWidth;
    const current = ring * ringWidth;
    for (const [from, to] of strips) {
      for (let column = from; column < to; column++) {
        const a = previous + column;
        const b = previous + column + 1;
        const c = current + column + 1;
        const d = current + column;
        // 上から見て反時計回り ＝ 法線が +Y。裏面カリングに落ちないのはこの順だけ
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint16Array(indices);
  return {
    name: `track-${String(sector).padStart(2, '0')}`,
    positions: positionArray,
    normals: computeNormals(positionArray, indexArray),
    uvs: new Float32Array(uvs),
    indices: indexArray,
    triangles: indexArray.length / 3,
  };
}

/**
 * 路面アトラス。u 帯ごとに路面 / 縁石 / 草地を描き、v 方向はシームレスに繋がるようにする。
 *
 * `wrap: 'repeat'` で登録し、u は帯の内側に収める。第4世代は linear フィルタなので
 * 帯の境界がにじむが、`BAND` が各帯の内側 1.5 % を空けてあり、メッシュの UV は
 * そこまで届かない。ミップマップは使われないので、遠方で帯が混ざることも無い。
 */
function buildSurfaceTexture(size) {
  const raster = new Raster(size, size);
  const band = (u) => Math.round(u * size);

  // ── 路面: 暗いアスファルト＋外側の白線＋中央の破線
  const roadFrom = band(0);
  const roadTo = band(0.5);
  for (let y = 0; y < size; y++) {
    for (let x = roadFrom; x < roadTo; x++) {
      // 決定論的な粒状ノイズ（Math.random は使わない）
      const grain = ((x * 73 + y * 151) % 11) - 5;
      raster.blend(x, y, [56 + grain, 58 + grain, 62 + grain], 1);
    }
  }
  const edge = Math.max(1, Math.round(size * 0.012));
  for (let y = 0; y < size; y++) {
    for (let offset = 0; offset < edge; offset++) {
      raster.blend(roadFrom + Math.round(size * 0.02) + offset, y, [220, 220, 208], 1);
      raster.blend(roadTo - Math.round(size * 0.02) - offset, y, [220, 220, 208], 1);
    }
  }
  const center = Math.round((roadFrom + roadTo) / 2);
  for (let y = 0; y < size; y++) {
    // 1 タイル（8 m）につき前半だけ引く破線。速度感はこの流れで読む
    if (y % size < size / 2) {
      for (let offset = 0; offset < edge; offset++) {
        raster.blend(center - Math.floor(edge / 2) + offset, y, [216, 216, 200], 1);
      }
    }
  }

  // ── 縁石: 赤白の縞。1 タイル（4 m）に 4 本
  const curbFrom = band(0.5);
  const curbTo = band(0.7);
  for (let y = 0; y < size; y++) {
    const red = Math.floor((y / size) * 8) % 2 === 0;
    const color = red ? [196, 48, 40] : [232, 232, 224];
    for (let x = curbFrom; x < curbTo; x++) raster.blend(x, y, color, 1);
  }

  // ── 草地: 濃い緑に粒
  const grassFrom = band(0.7);
  const grassTo = band(0.88);
  for (let y = 0; y < size; y++) {
    for (let x = grassFrom; x < grassTo; x++) {
      const grain = ((x * 37 + y * 89) % 13) - 6;
      raster.blend(x, y, [40 + grain, 92 + grain * 2, 44 + grain], 1);
    }
  }

  // ── 壁（8-6）: コンクリートの面に、上端の赤白のライン。
  // u が縦方向（下端 → 上端）なので、u の大きいほうが壁の上になる
  const wallFrom = band(0.88);
  for (let y = 0; y < size; y++) {
    for (let x = wallFrom; x < size; x++) {
      const height = (x - wallFrom) / (size - wallFrom);
      const grain = ((x * 53 + y * 101) % 9) - 4;
      // 上端の 22 % は 4 m ごとの赤白のライン。壁の縁と距離感がここで読める
      const stripe = height > 0.78 && Math.floor((y / size) * 4) % 2 === 0;
      const color = stripe
        ? [188, 56, 48]
        : height > 0.78
          ? [224, 224, 216]
          : [132 + grain, 134 + grain, 130 + grain];
      raster.blend(x, y, color, 1);
    }
  }

  return raster.toPng();
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  return buffer.length;
}

console.log(`コース: 全長 ${TRACK.length.toFixed(1)} m`);

for (const generation of GENERATION_IDS) {
  const lod = TRACK_MESH_LODS[generation];
  if (!lod) continue;

  const step = TRACK.length / (lod.sectorCount * lod.segmentsPerSector);
  console.log(
    `[${generation}] ${lod.sectorCount} セクター × ${lod.segmentsPerSector} 輪 / 刻み ${step.toFixed(3)} m`,
  );

  let triangles = 0;
  let bytes = 0;
  for (let sector = 0; sector < lod.sectorCount; sector++) {
    const mesh = buildSector(lod, sector);
    triangles += mesh.triangles;
    bytes += write(`public/${trackSectorAsset(lod, sector)}`, encodeGlb(mesh));
  }
  const textureBytes = write(
    `public/${trackSurfaceTexture(lod)}`,
    buildSurfaceTexture(lod.textureSize),
  );

  const drawn = Math.min(lod.sectorCount, lod.visibleRadius * 2 + 1);
  console.log(
    `  合計 ${triangles} tri / ${(bytes / 1024).toFixed(0)} KB` +
      `（1 セクター ${Math.round(triangles / lod.sectorCount)} tri）`,
  );
  console.log(
    `  同時描画 ${drawn} セクター ＝ ${Math.round((triangles / lod.sectorCount) * drawn)} tri / ` +
      `前方保証 ${(lod.visibleRadius * (TRACK.length / lod.sectorCount)).toFixed(0)} m`,
  );
  console.log(
    `  路面アトラス ${lod.textureSize}² / ${(textureBytes / 1024).toFixed(1)} KB`,
  );
}

console.log('コースメッシュ生成 完了');
