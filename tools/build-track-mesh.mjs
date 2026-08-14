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
  TRACK_ATLAS,
  TRACK_ATLAS_SLOTS,
  TRACK_ATLAS_TILES,
  TRACK_MESH_LODS,
  roadColumns,
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

// ── v のタイル長 [m]。定義は `track-mesh.ts` にあり、タイヤの帯は背景メッシュとも共有する
const TILE = TRACK_ATLAS_TILES;

/**
 * 断面の 1 点。`lateral` は中心線からの右向き距離、`height` は路面からの高さ。
 * どちらもバンク回転の前の値で、ワールドへ移すときにまとめて回す。
 *
 * `fenceHeight` を持つ LOD（第4世代）だけは、壁の上に金網の面を 1 枚ずつ足す。
 * 壁と分けるのは u の密度のためで、金網は 46 texel/m 無いと網目が読めない
 * （壁の帯へ押し込むと 20 texel/m しか取れず、遠方で網目がちらつくだけになる）。
 *
 * 路面の列 `columns` は `roadColumns()` が決める。等分ではなく**中央の破線の縁を
 * 含む**列で、そのおかげで破線がアフィン歪みで折れない（8-11）。
 */
function crossSection(halfWidth, columns, fenceHeight) {
  const points = [];
  const push = (lateral, height, u, tile) => points.push({ lateral, height, u, tile });
  const outer = halfWidth + CURB_WIDTH + GRASS_WIDTH;
  const apronHeight = -GRASS_DROP + WALL_HEIGHT;
  const strips = [];
  const fence = fenceHeight ?? 0;

  // 左の土手。壁の上端の高さで平らに伸ばす。**列は左から右へ**（法線が上を向く向き）
  push(-(outer + APRON_WIDTH), apronHeight, TRACK_ATLAS.grass.outer, TILE.grass);
  push(-outer, apronHeight, TRACK_ATLAS.grass.inner, TILE.grass);
  strips.push([0, 1]);

  // 左の金網（あれば）。**列は上から下へ** — 壁と同じ理由で、法線がコース中心を向く
  if (fence > 0) {
    push(-outer, apronHeight + fence, TRACK_ATLAS.fence.top, TILE.fence);
    push(-outer, apronHeight, TRACK_ATLAS.fence.bottom, TILE.fence);
    strips.push([2, 3]);
  }

  // 左の壁。**列は上から下へ並べる** — 面の法線は「列の向き × 進行方向」なので、
  // 上から下へ並べたときだけ法線がコース中心（右）を向く。逆にすると裏面カリングで消える
  const wall = points.length;
  push(-outer, apronHeight, TRACK_ATLAS.wall.top, TILE.wall);
  push(-outer, -GRASS_DROP, TRACK_ATLAS.wall.bottom, TILE.wall);
  strips.push([wall, wall + 1]);

  push(-outer, -GRASS_DROP, TRACK_ATLAS.grass.outer, TILE.grass);
  push(-(halfWidth + CURB_WIDTH), -CURB_DROP, TRACK_ATLAS.grass.inner, TILE.grass);
  strips.push([wall + 2, wall + 3]);
  push(-(halfWidth + CURB_WIDTH), -CURB_DROP, TRACK_ATLAS.curb.outer, TILE.curb);
  push(-halfWidth, 0, TRACK_ATLAS.curb.inner, TILE.curb);
  strips.push([wall + 4, wall + 5]);

  const road = points.length;
  for (const t of columns) {
    push(
      -halfWidth + 2 * halfWidth * t,
      0,
      TRACK_ATLAS.road.from + (TRACK_ATLAS.road.to - TRACK_ATLAS.road.from) * t,
      TILE.road,
    );
  }
  strips.push([road, road + columns.length - 1]);

  const last = points.length;
  push(halfWidth, 0, TRACK_ATLAS.curb.inner, TILE.curb);
  push(halfWidth + CURB_WIDTH, -CURB_DROP, TRACK_ATLAS.curb.outer, TILE.curb);
  strips.push([last, last + 1]);
  push(halfWidth + CURB_WIDTH, -CURB_DROP, TRACK_ATLAS.grass.inner, TILE.grass);
  push(outer, -GRASS_DROP, TRACK_ATLAS.grass.outer, TILE.grass);
  strips.push([last + 2, last + 3]);

  // 右の壁は逆に、下から上へ（法線がコース中心 ＝ 左を向く）
  push(outer, -GRASS_DROP, TRACK_ATLAS.wall.bottom, TILE.wall);
  push(outer, apronHeight, TRACK_ATLAS.wall.top, TILE.wall);
  strips.push([last + 4, last + 5]);

  // 右の金網（あれば）も下から上へ
  if (fence > 0) {
    const at = points.length;
    push(outer, apronHeight, TRACK_ATLAS.fence.bottom, TILE.fence);
    push(outer, apronHeight + fence, TRACK_ATLAS.fence.top, TILE.fence);
    strips.push([at, at + 1]);
  }

  // 右の土手
  const apron = points.length;
  push(outer, apronHeight, TRACK_ATLAS.grass.inner, TILE.grass);
  push(outer + APRON_WIDTH, apronHeight, TRACK_ATLAS.grass.outer, TILE.grass);
  strips.push([apron, apron + 1]);

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
  const columns = roadColumns(lod);

  const positions = [];
  const uvs = [];
  const indices = [];
  let ringWidth = 0;

  for (let ring = 0; ring <= lod.segmentsPerSector; ring++) {
    const s = (firstRing + ring) * step;
    const sample = TRACK.sampleAt(s);
    const { points, strips } = crossSection(sample.halfWidth, columns, lod.fenceHeight);
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
 * 路面アトラス。u 帯ごとに路面 / 縁石 / 草地 / 壁 / 金網 / タイヤを描き、
 * v 方向はシームレスに繋がるようにする。
 *
 * `wrap: 'repeat'` で登録し、u は帯の内側に収める。第4世代は linear フィルタなので
 * 帯の境界がにじむが、`TRACK_ATLAS` が各帯の内側 0.012 を空けてあり、メッシュの UV は
 * そこまで届かない。ミップマップは使われないので、遠方で帯が混ざることも無い。
 *
 * **金網の帯だけはアルファを持つ。** 引くのは第4世代だけで、マテリアルの
 * `alphaCutoff` が網目の穴を捨てる。他の帯は全画素不透明なので、
 * 同じマテリアルで路面を描いても 1 画素も落ちない。
 */
function buildSurfaceTexture(size, fenceHeight) {
  const raster = new Raster(size, size);
  const band = (u) => Math.round(u * size);
  /** 決定論的な粒（`Math.random` は使わない） */
  const grain = (x, y, a, b) => ((x * a + y * b) % 11) - 5;

  // ── 路面: 暗いアスファルト＋外側の白線＋中央の破線
  const roadFrom = band(TRACK_ATLAS_SLOTS.road[0]);
  const roadTo = band(TRACK_ATLAS_SLOTS.road[1]);
  const roadWidth = roadTo - roadFrom;
  for (let y = 0; y < size; y++) {
    for (let x = roadFrom; x < roadTo; x++) {
      const noise = grain(x, y, 73, 151);
      raster.blend(x, y, [56 + noise, 58 + noise, 62 + noise], 1);
    }
  }
  const edge = Math.max(1, Math.round(roadWidth * 0.03));
  for (let y = 0; y < size; y++) {
    for (let offset = 0; offset < edge; offset++) {
      raster.blend(roadFrom + Math.round(roadWidth * 0.05) + offset, y, [220, 220, 208], 1);
      raster.blend(roadTo - Math.round(roadWidth * 0.05) - offset, y, [220, 220, 208], 1);
    }
  }
  // 中央の破線は `TRACK_ATLAS.centerLine` の帯だけを塗る。**幅を texel で決めるのではなく
  // 帯から引く**のが要で、メッシュ側は同じ帯の縁に頂点の列を置く（`roadColumns`）。
  // 線の縁が頂点になっていれば、アフィン歪みで線が折れない（8-11）
  const lineFrom = band(TRACK_ATLAS.centerLine.from);
  const lineTo = band(TRACK_ATLAS.centerLine.to);
  for (let y = 0; y < size / 2; y++) {
    // 1 タイル（8 m）につき前半だけ引く破線。速度感はこの流れで読む
    for (let x = lineFrom; x < lineTo; x++) {
      raster.blend(x, y, [216, 216, 200], 1);
    }
  }

  // ── 縁石: 赤白の縞。1 タイル（4 m）に 4 本
  for (let y = 0; y < size; y++) {
    const red = Math.floor((y / size) * 8) % 2 === 0;
    const color = red ? [196, 48, 40] : [232, 232, 224];
    for (let x = band(TRACK_ATLAS_SLOTS.curb[0]); x < band(TRACK_ATLAS_SLOTS.curb[1]); x++) {
      raster.blend(x, y, color, 1);
    }
  }

  // ── 草地: 濃い緑に粒
  for (let y = 0; y < size; y++) {
    for (let x = band(TRACK_ATLAS_SLOTS.grass[0]); x < band(TRACK_ATLAS_SLOTS.grass[1]); x++) {
      const noise = ((x * 37 + y * 89) % 13) - 6;
      raster.blend(x, y, [40 + noise, 92 + noise * 2, 44 + noise], 1);
    }
  }

  // ── 壁（8-6）: コンクリートの面に、上端の赤白のライン。
  // u が縦方向（下端 → 上端）なので、u の大きいほうが壁の上になる
  const wallFrom = band(TRACK_ATLAS_SLOTS.wall[0]);
  const wallTo = band(TRACK_ATLAS_SLOTS.wall[1]);
  for (let y = 0; y < size; y++) {
    for (let x = wallFrom; x < wallTo; x++) {
      const height = (x - wallFrom) / (wallTo - wallFrom);
      const noise = grain(x, y, 53, 101);
      // 上端の 22 % は 4 m ごとの赤白のライン。壁の縁と距離感がここで読める
      const stripe = height > 0.78 && Math.floor((y / size) * 4) % 2 === 0;
      const color = stripe
        ? [188, 56, 48]
        : height > 0.78
          ? [224, 224, 216]
          : [132 + noise, 134 + noise, 130 + noise];
      raster.blend(x, y, color, 1);
    }
  }

  // ── 金網（8-10）: 支柱・上下の胴縁・菱形の網。**ここだけ画素が抜ける**
  paintFence(raster, size, fenceHeight);
  // ── タイヤフェンス（8-10）: 積んだタイヤの弧に沿って引く帯
  paintTyres(raster, size);

  return raster.toPng();
}

/**
 * 金網フェンスの帯。u が高さ（下端 → 上端）、v が進行方向。
 *
 * **形を読ませるのは支柱と胴縁で、網は霞ませる。** 網目だけを細かく描くと、
 * ミップマップの無い linear フィルタでは遠方が単なるちらつきになる（実機の
 * 金網フェンスもそう見えていた）。4 m ごとの支柱と上下 2 本の胴縁は不透明な
 * 直線なので距離が変わっても輪郭が残り、そこにトーンとしての網が乗る。
 *
 * `fenceHeight` が `null` の LOD（第3世代）では帯を空のまま残す。
 * 引く面が 1 つも無いので、透明のままでも実害は無い。
 */
function paintFence(raster, size, fenceHeight) {
  if (!fenceHeight) return;
  const from = band01(TRACK_ATLAS_SLOTS.fence[0], size);
  const to = band01(TRACK_ATLAS_SLOTS.fence[1], size);
  /** 帯の 1 画素が受け持つ高さ [m] と、v 1 画素が受け持つ長さ [m] */
  const metresPerU = fenceHeight / (to - from);
  const metresPerV = TILE.fence / size;
  /** 網目の対角の間隔 [m]。当時のフェンスの目合いより粗く採る（読めることを優先） */
  const mesh = 0.22;

  for (let x = from; x < to; x++) {
    const height = (x - from) * metresPerU;
    for (let y = 0; y < size; y++) {
      const along = y * metresPerV;
      // 支柱（4 m ごと・幅 0.12 m）と上下の胴縁
      const post = along < 0.12 || along > TILE.fence - 0.06;
      const rail = height < 0.08 || height > fenceHeight - 0.12;
      if (post || rail) {
        const noise = ((x * 29 + y * 61) % 7) - 3;
        raster.blend(x, y, [148 + noise, 152 + noise, 156 + noise], 1);
        continue;
      }
      // 菱形の網。2 本の対角線のどちらかに乗っている画素だけを残す。
      // `fract` は格子までの距離なので、0 か 1 に近いほど線の上にある
      const toDiagonal = (value) => Math.min(fract(value), 1 - fract(value));
      const wire = Math.min(
        toDiagonal((height + along) / mesh),
        toDiagonal((height - along) / mesh),
      );
      if (wire < 0.1) raster.blend(x, y, [186, 190, 194], 1);
    }
  }
}

/**
 * タイヤフェンスの帯。u はタイヤの弧に沿った位置（背面 → 頂点 → 背面）、v は進行方向。
 *
 * 1 タイル 2.8 m にタイヤ 4 本。継ぎ目の溝を 0.7 m ごとに落とし、
 * **4 本に 1 本を白いタイヤ**にする（実車のタイヤバリアと同じで、これが無いと
 * 帯がのっぺりして距離が読めない）。弧の頂点へ向かって明るくするので、
 * 半円柱に貼ったときに丸みがそのまま出る（`build-scenery-mesh.mjs`）。
 */
function paintTyres(raster, size) {
  const from = band01(TRACK_ATLAS_SLOTS.tyres[0], size);
  const to = band01(TRACK_ATLAS_SLOTS.tyres[1], size);
  /** 1 タイルに入るタイヤの本数 */
  const perTile = Math.round(TILE.tyres / 0.7);

  for (let x = from; x < to; x++) {
    // 弧の中央（＝コース側の頂点）が最も明るい。ゴムなので反射は弱い
    const along = (x - from) / (to - from);
    const facing = 1 - Math.abs(along - 0.5) * 2;
    for (let y = 0; y < size; y++) {
      const tyre = (y / size) * perTile;
      const index = Math.floor(tyre);
      // 継ぎ目の溝。タイヤの縁は丸いので、溝へ向かって暗く落ちる
      const seam = Math.abs(fract(tyre) - 0.5) * 2;
      const round = Math.min(1, (1 - seam) * 3);
      const noise = ((x * 41 + y * 97) % 9) - 4;
      const pale = index % perTile === 2;
      const base = pale ? 150 : 34;
      const lift = pale ? 74 : 46;
      const shade = (base + facing * lift + noise) * (0.35 + 0.65 * round);
      raster.blend(x, y, [shade, shade, shade * 1.03], 1);
    }
  }
}

function band01(u, size) {
  return Math.round(u * size);
}

function fract(value) {
  return value - Math.floor(value);
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
    buildSurfaceTexture(lod.textureSize, lod.fenceHeight),
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
