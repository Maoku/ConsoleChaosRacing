#!/usr/bin/env tsx
/**
 * 第3世代の 1 フレームをオフラインで焼き、路面のアフィン UV を検証する（8-11 の調査用）。
 *
 * 実物の GLB とカメラを使い、GPU と同じ手順（頂点量子化 → クリップ空間 6 面クリップ →
 * 遠近補正つき補間 → affineUv = I(uv*w)/I(w)）でラスタライズする。
 * アフィン版と遠近補正版を並べて出すので、「歪みなのか壊れているのか」を切り分けられる。
 *
 *   npx tsx tools/debug-gen3-frame.mjs [s] [lateral]
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGlb, parseGltf } from '@console-chaos/engine';

import { TRACK } from '../src/game/sim/track.ts';
import { viewCamera } from '../src/game/view/shared/camera.ts';
import {
  TRACK_ATLAS,
  TRACK_MESH_LODS,
  trackSectorAsset,
  trackSurfaceTexture,
  visibleSectors,
} from '../src/game/view/shared/track-mesh.ts';
import { decodePng, Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOD = TRACK_MESH_LODS.PS1;

// 第3世代の内部解像度と頂点量子化（HARDWARE_GENERATION_PROFILES.PS1）
const W = 320;
const H = 240;
const QUANTIZE = 2;
const NEAR = 0.1;
const FAR = 200;

const S = Number(process.argv[2] ?? 0);
const LATERAL = Number(process.argv[3] ?? 0);

// ── カメラ（停止中 ＝ 画角 60°）
const car = { entrant: 0, s: S, lateral: LATERAL, speed: 0, yaw: 0 };
const command = viewCamera({ track: TRACK, car, view: 'chase' });
const fov = command.fovDegrees;

function lookAt(eye, target) {
  const f = norm(sub(target, eye));
  const r = norm(cross(f, [0, 1, 0]));
  const u = cross(r, f);
  return [
    [r[0], u[0], -f[0], 0],
    [r[1], u[1], -f[1], 0],
    [r[2], u[2], -f[2], 0],
    [-dot(r, eye), -dot(u, eye), dot(f, eye), 1],
  ];
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const norm = (v) => {
  const l = Math.hypot(...v);
  return [v[0] / l, v[1] / l, v[2] / l];
};

const view = lookAt(command.position, command.target);
const focal = 1 / Math.tan((fov * Math.PI) / 360);
const aspect = W / H;

/** ワールド → クリップ空間（列優先の 4×4 を手で掛ける） */
function toClip(p) {
  const vx = view[0][0] * p[0] + view[1][0] * p[1] + view[2][0] * p[2] + view[3][0];
  const vy = view[0][1] * p[0] + view[1][1] * p[1] + view[2][1] * p[2] + view[3][1];
  const vz = view[0][2] * p[0] + view[1][2] * p[1] + view[2][2] * p[2] + view[3][2];
  return {
    x: (focal / aspect) * vx,
    y: focal * vy,
    z: ((FAR + NEAR) / (NEAR - FAR)) * vz + ((2 * FAR * NEAR) / (NEAR - FAR)),
    w: -vz,
  };
}

/** ps1_vertex.glsl の頂点量子化 */
function quantize(c) {
  if (QUANTIZE <= 0) return c;
  const gx = Math.max(W / QUANTIZE, 1);
  const gy = Math.max(H / QUANTIZE, 1);
  const nx = Math.floor((c.x / c.w) * gx + 0.5) / gx;
  const ny = Math.floor((c.y / c.w) * gy + 0.5) / gy;
  return { x: nx * c.w, y: ny * c.w, z: c.z, w: c.w };
}

const PLANES = [
  (v) => v.w + v.x,
  (v) => v.w - v.x,
  (v) => v.w + v.y,
  (v) => v.w - v.y,
  (v) => v.w + v.z,
  (v) => v.w - v.z,
];

/**
 * EXACT_CLIP = true にすると、クリップで作る頂点の `uv*w` を
 * 「uv(t) × w(t)」と正しく求める（GPU は uv*w を線形補間するので二次項ぶんずれる）。
 * これで楔が消えるなら、原因は近クリップだと確定する。
 */
const EXACT_CLIP = process.env.EXACT_CLIP === '1';

function lerp(a, b, t) {
  const w = a.w + (b.w - a.w) * t;
  const uvc = [
    a.uvc[0] + (b.uvc[0] - a.uvc[0]) * t,
    a.uvc[1] + (b.uvc[1] - a.uvc[1]) * t,
  ];
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t,
    w,
    uvw: EXACT_CLIP
      ? [uvc[0] * w, uvc[1] * w]
      : [a.uvw[0] + (b.uvw[0] - a.uvw[0]) * t, a.uvw[1] + (b.uvw[1] - a.uvw[1]) * t],
    uvc,
  };
}

function clip(poly) {
  let current = poly;
  for (const dist of PLANES) {
    const out = [];
    for (let i = 0; i < current.length; i++) {
      const a = current[i];
      const b = current[(i + 1) % current.length];
      const da = dist(a);
      const db = dist(b);
      if (da >= 0) out.push(a);
      if (da >= 0 !== db >= 0) out.push(lerp(a, b, da / (da - db)));
    }
    current = out;
    if (!current.length) return current;
  }
  return current;
}

// ── 路面アトラス
const atlas = decodePng(readFileSync(join(repoRoot, 'public', trackSurfaceTexture(LOD))));
function sample(u, v) {
  const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(((u % 1) + 1) % 1 * atlas.width)));
  const y = Math.min(atlas.height - 1, Math.max(0, Math.floor(((v % 1) + 1) % 1 * atlas.height)));
  const o = (y * atlas.width + x) * 4;
  return [atlas.pixels[o], atlas.pixels[o + 1], atlas.pixels[o + 2]];
}

// ── 三角形を集める
const triangles = [];
for (const sector of visibleSectors(LOD, S, TRACK.length)) {
  const bytes = readFileSync(join(repoRoot, 'public', trackSectorAsset(LOD, sector)));
  const { json, binary } = parseGlb(
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  );
  const prim = parseGltf(json, binary ? [binary] : []).meshes[0].primitives[0];
  const { positions, uvs, indices } = prim;
  for (let i = 0; i < indices.length; i += 3) {
    const verts = [];
    for (let k = 0; k < 3; k++) {
      const idx = indices[i + k];
      const p = [positions[idx * 3], positions[idx * 3 + 1], positions[idx * 3 + 2]];
      const uv = [uvs[idx * 2], uvs[idx * 2 + 1]];
      const c = quantize(toClip(p));
      verts.push({ ...c, uvw: [uv[0] * c.w, uv[1] * c.w], uvc: uv });
    }
    triangles.push(verts);
  }
}

/** 1 枚焼く。mode = 'affine' | 'correct' | 'band'（破線の帯だけ塗り分け） */
function render(mode) {
  const raster = new Raster(W, H);
  const depth = new Float32Array(W * H).fill(Infinity);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) raster.blend(x, y, [24, 48, 84], 1);

  for (const tri of triangles) {
    const poly = clip(tri);
    for (let i = 1; i + 1 < poly.length; i++) {
      const t = [poly[0], poly[i], poly[i + 1]];
      const p = t.map((v) => [W / 2 + (v.x / v.w) * (W / 2), H / 2 - (v.y / v.w) * (H / 2)]);
      const minX = Math.max(0, Math.floor(Math.min(...p.map((q) => q[0]))));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(...p.map((q) => q[0]))));
      const minY = Math.max(0, Math.floor(Math.min(...p.map((q) => q[1]))));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(...p.map((q) => q[1]))));
      const area =
        (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (Math.abs(area) < 1e-12) continue;

      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const l0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area;
          const l1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const l = [l0, l1, l2];
          const invW = l.reduce((s, li, k) => s + li / t[k].w, 0);
          const zView = 1 / invW;
          const o = y * W + x;
          if (zView >= depth[o]) continue;
          depth[o] = zView;
          const pc = (pick) => l.reduce((s, li, k) => s + (li * pick(t[k])) / t[k].w, 0) / invW;
          let uv;
          if (mode === 'correct') {
            uv = [pc((v) => v.uvc[0]), pc((v) => v.uvc[1])];
          } else {
            const vw = pc((v) => v.w);
            uv = [pc((v) => v.uvw[0]) / vw, pc((v) => v.uvw[1]) / vw];
          }
          if (mode === 'band') {
            // 破線の帯に入った画素だけ赤、路面は灰
            const inBand = uv[0] >= TRACK_ATLAS.centerLine.from && uv[0] <= TRACK_ATLAS.centerLine.to;
            raster.blend(x, y, inBand ? [230, 40, 40] : [70, 70, 74], 1);
          } else {
            raster.blend(x, y, sample(uv[0], uv[1]), 1);
          }
        }
      }
    }
  }
  return raster;
}

for (const mode of ['affine', 'correct', 'band']) {
  const file = join(repoRoot, `Docs/screenshots/debug-gen3-${mode}.png`);
  writeFileSync(file, render(mode).toPng());
  console.log(`${mode} → ${file}`);
}

// 破線の帯が各走査線で何画素ぶん白くなるかを、アフィンと遠近補正で比べる
function bandWidths(mode) {
  const rows = new Map();
  for (const tri of triangles) {
    const poly = clip(tri);
    for (let i = 1; i + 1 < poly.length; i++) {
      const t = [poly[0], poly[i], poly[i + 1]];
      const p = t.map((v) => [W / 2 + (v.x / v.w) * (W / 2), H / 2 - (v.y / v.w) * (H / 2)]);
      const area =
        (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (Math.abs(area) < 1e-12) continue;
      const minX = Math.max(0, Math.floor(Math.min(...p.map((q) => q[0]))));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(...p.map((q) => q[0]))));
      const minY = Math.max(0, Math.floor(Math.min(...p.map((q) => q[1]))));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(...p.map((q) => q[1]))));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const l0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area;
          const l1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const l = [l0, l1, l2];
          const invW = l.reduce((s, li, k) => s + li / t[k].w, 0);
          const pc = (pick) => l.reduce((s, li, k) => s + (li * pick(t[k])) / t[k].w, 0) / invW;
          let u;
          if (mode === 'correct') u = pc((v) => v.uvc[0]);
          else u = pc((v) => v.uvw[0]) / pc((v) => v.w);
          if (u >= TRACK_ATLAS.centerLine.from && u <= TRACK_ATLAS.centerLine.to) {
            rows.set(y, (rows.get(y) ?? 0) + 1);
          }
        }
      }
    }
  }
  return rows;
}

/** 帯を偽って塗った画素が、どの四角形（＝頂点 u の範囲）から出ているかを数える */
function culprits() {
  const tally = new Map();
  for (const tri of triangles) {
    const own = [Math.min(...tri.map((v) => v.uvc[0])), Math.max(...tri.map((v) => v.uvc[0]))];
    // 帯を自分の範囲に持つ三角形（＝本物の破線）は除く
    const owns = own[0] <= TRACK_ATLAS.centerLine.from && own[1] >= TRACK_ATLAS.centerLine.to;
    const poly = clip(tri);
    for (let i = 1; i + 1 < poly.length; i++) {
      const t = [poly[0], poly[i], poly[i + 1]];
      const p = t.map((v) => [W / 2 + (v.x / v.w) * (W / 2), H / 2 - (v.y / v.w) * (H / 2)]);
      const area =
        (p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[2][0] - p[0][0]) * (p[1][1] - p[0][1]);
      if (Math.abs(area) < 1e-12) continue;
      const minX = Math.max(0, Math.floor(Math.min(...p.map((q) => q[0]))));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(...p.map((q) => q[0]))));
      const minY = Math.max(0, Math.floor(Math.min(...p.map((q) => q[1]))));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(...p.map((q) => q[1]))));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const px = x + 0.5;
          const py = y + 0.5;
          const l0 = ((p[1][0] - px) * (p[2][1] - py) - (p[2][0] - px) * (p[1][1] - py)) / area;
          const l1 = ((p[2][0] - px) * (p[0][1] - py) - (p[0][0] - px) * (p[2][1] - py)) / area;
          const l2 = 1 - l0 - l1;
          if (l0 < 0 || l1 < 0 || l2 < 0) continue;
          const l = [l0, l1, l2];
          const invW = l.reduce((s, li, k) => s + li / t[k].w, 0);
          const pc = (pick) => l.reduce((s, li, k) => s + (li * pick(t[k])) / t[k].w, 0) / invW;
          const u = pc((v) => v.uvw[0]) / pc((v) => v.w);
          if (u < TRACK_ATLAS.centerLine.from || u > TRACK_ATLAS.centerLine.to) continue;
          const key = owns
            ? '破線の四角形（本物）'
            : `他の四角形 u=[${own[0].toFixed(3)}, ${own[1].toFixed(3)}]`;
          const prev = tally.get(key) ?? { px: 0, drift: 0, du: own[1] - own[0] };
          prev.px++;
          prev.drift = Math.max(prev.drift, u - own[1], own[0] - u);
          tally.set(key, prev);
        }
      }
    }
  }
  return tally;
}

console.log(`\n帯に入った画素の出どころ（アフィン / EXACT_CLIP=${EXACT_CLIP ? 1 : 0}）`);
for (const [key, v] of [...culprits()].sort((a, b) => b[1].px - a[1].px).slice(0, 8)) {
  console.log(
    `  ${String(v.px).padStart(6)} px  ${key}` +
      (v.drift > 0
        ? `  ← 自分の u 範囲（幅 ${v.du.toFixed(4)}）から ${v.drift.toFixed(5)} はみ出した`
        : ''),
  );
}

const affine = bandWidths('affine');
const correct = bandWidths('correct');
console.log('\n走査線ごとの「破線の帯に入った画素数」（画面下ほど手前）');
console.log('  走査線   アフィン   遠近補正   差');
for (let y = 120; y < H; y += 8) {
  const a = affine.get(y) ?? 0;
  const c = correct.get(y) ?? 0;
  if (!a && !c) continue;
  console.log(
    `  ${String(y).padStart(5)}   ${String(a).padStart(6)}   ${String(c).padStart(8)}   ` +
      `${a - c > 0 ? '+' : ''}${a - c}`,
  );
}
