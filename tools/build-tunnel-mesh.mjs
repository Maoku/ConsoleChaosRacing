#!/usr/bin/env tsx
/**
 * トンネル区間の躯体・照明・アトラス（実装計画 §2.6 / 8-9）。
 *
 *   npm run build:tunnel
 *
 * 3D の 2 世代ぶんを焼く。位置と寸法は `src/game/view/shared/tunnel.ts` の
 * `TUNNEL` にしかなく、実行時のビューと**同じ 1 つの表**を読む。
 *
 * ## なぜコースメッシュへ焼き込まないのか
 *
 * 壁と土手（8-6）はセクター GLB へ焼き込んだ。バンクのついた路面に沿わせるには
 * X/Z 回転が要るからで、その事情はトンネルも同じである。にもかかわらず別の GLB に
 * するのは、**マテリアルを分けるため**である — メッシュ 1 つにつきマテリアルは
 * 1 つしか指定できないので、路面と同じメッシュへ入れると
 *
 *   - トンネルの中だけ暗い（`ambient` を落とした）マテリアル
 *   - 環境光が落ちても明るいままの灯具
 *
 * のどちらも作れない。区間が 220 m しかなく、位置が固定で、そこへ近づいたときだけ
 * 積めばよいので、独立したメッシュにする不利は無い。
 *
 * ## 形
 *
 * 断面は半楕円ヴォールト。側壁が 4 m まで立ち上がり、そこから天井の頂点 6.4 m まで
 * 8 面のアーチで繋ぐ。足元には歩廊（幅 0.8 m・高さ 0.3 m）を付ける。
 * 外側には殻を張って、平坦なコースの真ん中でも「構造物」として立って見えるようにする
 * （丘が無いので、坑口だけでは宙に浮いた穴に見える）。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { TRACK } from '../src/game/sim/track.ts';
import { TRACK_MESH_LODS } from '../src/game/view/shared/track-mesh.ts';
import {
  TUNNEL,
  tunnelAsset,
  tunnelLampAsset,
  tunnelTexture,
} from '../src/game/view/shared/tunnel.ts';
import { computeNormals, encodeGlb } from './lib/glb.mjs';
import { Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * アトラスの u 帯（`buildTunnelTexture` と一致させる）。
 * 路面アトラス（`build-track-mesh.mjs` の `BAND`）と同じ作りで、
 * 面ごとにテクスチャを分ける代わりに 1 枚の別々の帯へ写す。
 */
const BAND = {
  wall: [0.01, 0.18],
  ledge: [0.2, 0.29],
  arch: [0.31, 0.52],
  shell: [0.54, 0.69],
  rim: [0.71, 0.84],
  lamp: [0.86, 0.99],
};

/** v のタイル長 [m]。灯具だけは間隔そのもの（1 タイルに 1 灯） */
const TILE = { wall: 4, ledge: 4, arch: 4, shell: 6, lamp: TUNNEL.lamp.spacing };

/**
 * 躯体の輪の刻み [m]。
 *
 * 直線・平坦・バンク 0° の区間なので、路面ほど細かく刻む理由が無い。
 * 路面の刻みの 1.5 倍（第3世代 6 m・第4世代 2 m）に採ると、
 * 三角形は第3世代 +1,800・第4世代 +5,300 で、どちらも予算の内側に収まる。
 */
function ringStep(lod) {
  return Math.max(2, (1.5 * TRACK.length) / (lod.sectorCount * lod.segmentsPerSector));
}

/** 帯 [from, to] の内側を t（0..1）で引く */
function bandU(band, t) {
  return band[0] + (band[1] - band[0]) * t;
}

// ─────────────────────────────────────────────────────────────
// 断面
// ─────────────────────────────────────────────────────────────

/**
 * アーチ上の点。i = 0 が右の起拱点、i = facets が左の起拱点。
 * **右から左へ並べる**のは、そうしないと法線が上を向いてしまうため
 * （面の法線は「列の進む向き × 進行方向」で、天井は下を向かなければならない）。
 */
function archPoint(halfWidth, index) {
  const angle = Math.PI / 2 - (Math.PI * index) / TUNNEL.archFacets;
  return {
    lateral: halfWidth * Math.sin(angle),
    height: TUNNEL.springHeight + (TUNNEL.crownHeight - TUNNEL.springHeight) * Math.cos(angle),
  };
}

/** 外殻の輪郭。内側の輪郭を `portalCenter` の高さを中心に `portalScale` 倍したもの */
function toShell(point) {
  return {
    lateral: point.lateral * TUNNEL.portalScale,
    height: TUNNEL.portalCenter + (point.height - TUNNEL.portalCenter) * TUNNEL.portalScale,
  };
}

/**
 * 断面 1 輪。`lateral` は中心線からの右向き距離、`height` は路面からの高さ。
 *
 * 面の法線は**列の進む向き × 進行方向**なので、内側を向かせるには
 * 左の壁を上から下へ、右の壁を下から上へ、天井を右から左へ並べる
 * （`build-track-mesh.mjs` の壁とまったく同じ事情）。
 */
function crossSection(halfWidth) {
  const points = [];
  const strips = [];
  const push = (lateral, height, u, tile) => points.push({ lateral, height, u, tile });

  const inner = halfWidth;
  const ledgeInner = halfWidth - TUNNEL.ledgeWidth;
  const base = -TUNNEL.buried;
  const { ledgeHeight, springHeight } = TUNNEL;
  /** 壁の u は「歩廊の高さ 〜 起拱点」を帯いっぱいに使う */
  const wallU = (height) =>
    bandU(BAND.wall, (height - ledgeHeight) / (springHeight - ledgeHeight));

  // 左の壁（上 → 下）
  push(-inner, springHeight, wallU(springHeight), TILE.wall);
  push(-inner, ledgeHeight, wallU(ledgeHeight), TILE.wall);
  strips.push([0, 1]);
  // 左の歩廊（上面 ＝ 左から右へ・内側の立ち上がり ＝ 上から下へ）
  push(-inner, ledgeHeight, bandU(BAND.ledge, 0), TILE.ledge);
  push(-ledgeInner, ledgeHeight, bandU(BAND.ledge, 0.5), TILE.ledge);
  strips.push([2, 3]);
  push(-ledgeInner, ledgeHeight, bandU(BAND.ledge, 0.5), TILE.ledge);
  push(-ledgeInner, base, bandU(BAND.ledge, 1), TILE.ledge);
  strips.push([4, 5]);
  // 右の歩廊（立ち上がり ＝ 下から上へ・上面 ＝ 左から右へ）
  push(ledgeInner, base, bandU(BAND.ledge, 1), TILE.ledge);
  push(ledgeInner, ledgeHeight, bandU(BAND.ledge, 0.5), TILE.ledge);
  strips.push([6, 7]);
  push(ledgeInner, ledgeHeight, bandU(BAND.ledge, 0.5), TILE.ledge);
  push(inner, ledgeHeight, bandU(BAND.ledge, 0), TILE.ledge);
  strips.push([8, 9]);
  // 右の壁（下 → 上）
  push(inner, ledgeHeight, wallU(ledgeHeight), TILE.wall);
  push(inner, springHeight, wallU(springHeight), TILE.wall);
  strips.push([10, 11]);

  // 天井（右の起拱点 → 頂点 → 左の起拱点）
  const archFrom = points.length;
  for (let index = 0; index <= TUNNEL.archFacets; index++) {
    const point = archPoint(inner, index);
    push(point.lateral, point.height, bandU(BAND.arch, index / TUNNEL.archFacets), TILE.arch);
  }
  strips.push([archFrom, archFrom + TUNNEL.archFacets]);

  // 外殻（左の裾 → 天井 → 右の裾）。外を向かせるので**左から右へ**並べる
  const shellFrom = points.length;
  for (const [index, point] of outline(inner).entries()) {
    const shell = toShell(point);
    push(shell.lateral, shell.height, bandU(BAND.shell, index / (TUNNEL.archFacets + 2)), TILE.shell);
  }
  strips.push([shellFrom, points.length - 1]);

  return { points, strips };
}

/**
 * 坑口の外形線（左の裾 → 左の起拱点 → 天井 → 右の起拱点 → 右の裾）。
 * 外殻も妻面もこの 1 本から作るので、両者の輪郭がずれることが起こらない。
 */
function outline(halfWidth) {
  const points = [{ lateral: -halfWidth, height: -TUNNEL.buried }];
  for (let index = TUNNEL.archFacets; index >= 0; index--) points.push(archPoint(halfWidth, index));
  points.push({ lateral: halfWidth, height: -TUNNEL.buried });
  return points;
}

// ─────────────────────────────────────────────────────────────
// 焼く
// ─────────────────────────────────────────────────────────────

/** 断面の 1 点をワールドへ。バンクは接線まわりの回転（`build-track-mesh.mjs` と同じ式） */
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

/** 躯体（側壁・歩廊・アーチ・外殻・坑口の妻面）を 1 つのメッシュへ */
function buildTunnel(lod) {
  const step = ringStep(lod);
  // 坑口のリムぶんだけ前後へ伸ばす。妻面はその先端に立つ
  const from = TUNNEL.from - TUNNEL.portalDepth;
  const to = TUNNEL.to + TUNNEL.portalDepth;
  const rings = Math.max(2, Math.round((to - from) / step));

  const positions = [];
  const uvs = [];
  const indices = [];
  let ringWidth = 0;

  for (let ring = 0; ring <= rings; ring++) {
    const s = from + ((to - from) * ring) / rings;
    const sample = TRACK.sampleAt(s);
    const { points, strips } = crossSection(sample.halfWidth + TUNNEL.wallMargin);
    ringWidth = points.length;

    for (const point of points) {
      const world = toWorldPoint(sample, point.lateral, point.height);
      positions.push(world[0], world[1], world[2]);
      uvs.push(point.u, s / point.tile);
    }

    if (ring === 0) continue;
    const previous = (ring - 1) * ringWidth;
    const current = ring * ringWidth;
    for (const [begin, end] of strips) {
      for (let column = begin; column < end; column++) {
        const a = previous + column;
        const b = previous + column + 1;
        const c = current + column + 1;
        const d = current + column;
        indices.push(a, b, c, a, c, d);
      }
    }
  }

  // ── 坑口の妻面。内側の輪郭と外殻の輪郭のあいだを環状に塞ぐ。
  // 巻き方をそのまま書くと法線が +接線（前）を向くので、入口だけ逆に巻く
  for (const [index, s] of [from, to].entries()) {
    const entrance = index === 0;
    const sample = TRACK.sampleAt(s);
    const inner = outline(sample.halfWidth + TUNNEL.wallMargin);
    const base = positions.length / 3;
    for (const point of inner) {
      for (const [side, place] of [[0, point], [1, toShell(point)]]) {
        const world = toWorldPoint(sample, place.lateral, place.height);
        positions.push(world[0], world[1], world[2]);
        uvs.push(bandU(BAND.rim, side), place.lateral / 2);
      }
    }
    for (let point = 0; point + 1 < inner.length; point++) {
      const a = base + point * 2;
      const b = base + point * 2 + 1;
      const c = base + (point + 1) * 2 + 1;
      const d = base + (point + 1) * 2;
      if (entrance) indices.push(a, c, b, a, d, c);
      else indices.push(a, b, c, a, c, d);
    }
  }

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint16Array(indices);
  if (positionArray.length / 3 > 65536) throw new Error('トンネルの頂点が 16bit を超えた');
  return {
    name: 'tunnel',
    positions: positionArray,
    normals: computeNormals(positionArray, indexArray),
    uvs: new Float32Array(uvs),
    indices: indexArray,
    triangles: indexArray.length / 3,
    ringWidth,
    rings,
  };
}

/**
 * 天井の照明。頂点に沿って下向きの帯を 1 本。
 *
 * 灯具そのものは v のタイル（`TUNNEL.lamp.spacing` ごとに 1 灯）で出す。
 * **躯体と別メッシュなのはマテリアルを分けるためだけ**で、形は帯 1 本しかない。
 */
function buildLamps(lod) {
  const step = ringStep(lod);
  const rings = Math.max(2, Math.round((TUNNEL.to - TUNNEL.from) / step));
  const half = TUNNEL.lamp.width / 2;
  const height = TUNNEL.crownHeight - TUNNEL.lamp.drop;

  const positions = [];
  const uvs = [];
  const indices = [];

  for (let ring = 0; ring <= rings; ring++) {
    const s = TUNNEL.from + ((TUNNEL.to - TUNNEL.from) * ring) / rings;
    const sample = TRACK.sampleAt(s);
    // 下を向かせるので**右から左へ**（列の向き × 進行方向 ＝ 下）
    for (const [index, lateral] of [half, -half].entries()) {
      const world = toWorldPoint(sample, lateral, height);
      positions.push(world[0], world[1], world[2]);
      uvs.push(bandU(BAND.lamp, index), s / TILE.lamp);
    }
    if (ring === 0) continue;
    const previous = (ring - 1) * 2;
    const current = ring * 2;
    indices.push(previous, previous + 1, current + 1, previous, current + 1, current);
  }

  const positionArray = new Float32Array(positions);
  const indexArray = new Uint16Array(indices);
  return {
    name: 'tunnel-lamp',
    positions: positionArray,
    normals: computeNormals(positionArray, indexArray),
    uvs: new Float32Array(uvs),
    indices: indexArray,
    triangles: indexArray.length / 3,
  };
}

// ─────────────────────────────────────────────────────────────
// アトラス
// ─────────────────────────────────────────────────────────────

/** 決定論的な粒（`Math.random` は使わない）。振幅 ±amount */
function grain(x, y, amount, seed = 0) {
  return (((x * 73 + y * 151 + seed * 37) % 11) - 5) * (amount / 5);
}

function buildTunnelTexture(size) {
  const raster = new Raster(size, size);
  const column = (u) => Math.round(u * size);
  const fill = (band, paint) => {
    const from = column(band[0] - 0.008);
    const to = column(band[1] + 0.008);
    for (let y = 0; y < size; y++) {
      for (let x = from; x < to; x++) {
        const t = (x - column(band[0])) / (column(band[1]) - column(band[0]));
        paint(x, y, Math.min(1, Math.max(0, t)), y / size);
      }
    }
  };

  // ── 側壁: 下ほど煤けたコンクリート。4 m ごとに目地、腰の高さに白い帯
  fill(BAND.wall, (x, y, t, v) => {
    const soot = Math.max(0, 0.55 - t) * 0.9;
    const noise = grain(x, y, 7);
    let color = [
      146 - soot * 96 + noise,
      148 - soot * 98 + noise,
      144 - soot * 100 + noise,
    ];
    // 腰の白い帯（上端から 1/4 のところ）。距離感はこの水平線で読む
    if (t > 0.68 && t < 0.82) color = [214 + noise, 212 + noise, 200 + noise];
    // 目地（v のタイル境界）
    if (v < 0.02) color = [color[0] * 0.62, color[1] * 0.62, color[2] * 0.62];
    raster.blend(x, y, color, 1);
  });

  // ── 歩廊: 上面は灰、内側の立ち上がりは黒白の縞（当時の点検路の見え方）
  fill(BAND.ledge, (x, y, t, v) => {
    const noise = grain(x, y, 5, 3);
    if (t < 0.5) {
      raster.blend(x, y, [132 + noise, 132 + noise, 126 + noise], 1);
      return;
    }
    const stripe = Math.floor(v * 8) % 2 === 0;
    raster.blend(x, y, stripe ? [206 + noise, 202 + noise, 186 + noise] : [58, 58, 62], 1);
  });

  // ── 天井: 側壁より暗いコンクリート。4 m ごとに梁のリブが走る
  fill(BAND.arch, (x, y, t, v) => {
    // 頂点（帯の中央）へ向かって暗く落ちる。光が届かない場所を絵で作る
    const crown = 1 - Math.abs(t - 0.5) * 2;
    const noise = grain(x, y, 6, 7);
    const shade = 116 - crown * 34 + noise;
    const rib = v < 0.06;
    raster.blend(x, y, rib ? [shade * 0.66, shade * 0.66, shade * 0.68] : [shade, shade, shade * 0.98], 1);
  });

  // ── 外殻: 外から見える面。日に焼けた明るいコンクリートに 6 m ごとの継ぎ目
  fill(BAND.shell, (x, y, t, v) => {
    const noise = grain(x, y, 8, 11);
    const top = 1 - Math.abs(t - 0.5) * 2;
    const shade = 158 + top * 26 + noise;
    const joint = v < 0.03;
    raster.blend(x, y, joint ? [shade * 0.78, shade * 0.78, shade * 0.76] : [shade, shade, shade * 0.94], 1);
  });

  // ── 坑口の妻面: 内側の縁を落として厚みを見せ、外へ向かって明るくする
  fill(BAND.rim, (x, y, t) => {
    const noise = grain(x, y, 6, 13);
    const shade = 96 + t * 96 + noise;
    raster.blend(x, y, [shade, shade, shade * 0.96], 1);
  });

  // ── 灯具: 暗い筐体に、`spacing` ごとの明るいナトリウム灯
  fill(BAND.lamp, (x, y, t, v) => {
    const lit = v < TUNNEL.lamp.length / TUNNEL.lamp.spacing;
    const edge = Math.abs(t - 0.5) * 2;
    const noise = grain(x, y, 4, 17);
    if (!lit || edge > 0.72) {
      raster.blend(x, y, [42 + noise, 40 + noise, 38 + noise], 1);
      return;
    }
    // 中心ほど白く、周辺は橙。ナトリウム灯の色そのもの
    const core = 1 - edge / 0.72;
    raster.blend(
      x,
      y,
      [244, 196 + core * 52, 128 + core * 92],
      1,
    );
  });

  return raster.toPng();
}

// ─────────────────────────────────────────────────────────────

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  return buffer.length;
}

console.log(
  `トンネル: s = ${TUNNEL.from}–${TUNNEL.to} m（${TUNNEL.to - TUNNEL.from} m）/ ` +
    `内空 ${(TRACK.sampleAt(TUNNEL.from).halfWidth + TUNNEL.wallMargin) * 2} × ${TUNNEL.crownHeight} m`,
);

for (const generation of GENERATION_IDS) {
  const lod = TRACK_MESH_LODS[generation];
  if (!lod) continue;

  const tunnel = buildTunnel(lod);
  const lamps = buildLamps(lod);
  const bytes =
    write(`public/${tunnelAsset(lod)}`, encodeGlb(tunnel)) +
    write(`public/${tunnelLampAsset(lod)}`, encodeGlb(lamps));
  const textureBytes = write(`public/${tunnelTexture(lod)}`, buildTunnelTexture(lod.textureSize));

  console.log(
    `[${generation}] 輪 ${tunnel.rings + 1}（刻み ${ringStep(lod).toFixed(1)} m）× ${tunnel.ringWidth} 点 / ` +
      `躯体 ${tunnel.triangles} tri ＋ 灯具 ${lamps.triangles} tri / ` +
      `${(bytes / 1024).toFixed(0)} KB ＋ アトラス ${lod.textureSize}² ${(textureBytes / 1024).toFixed(1)} KB`,
  );
}

console.log('トンネル生成 完了');
