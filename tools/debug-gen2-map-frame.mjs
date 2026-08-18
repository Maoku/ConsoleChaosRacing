#!/usr/bin/env tsx
/**
 * コースマップ（`build-road-map.mjs` の生成物）を、第2世代のアフィン面と**同じ式**で
 * 1 フレームぶん CPU で引く目視用ツール（`debug-gen3-frame.mjs` と同じ位置づけ）。
 *
 *   npx tsx tools/debug-gen2-map-frame.mjs [弧長 s ...] > preview.png
 *
 * 実行時のレンダラーへ手を入れる前に、**マップ参照へ切り替えたときの絵**を確かめる。
 * 走査線ごとの UV は将来 `affine-surface.ts` が積むものと同じ導出:
 *
 *     P(x) = C + z·F + (x - W/2)·(z/f)·R      （C はカメラ、F 前方、R 右）
 *     uv   = (P - マップ原点) · texel/m / マップ画素数
 *
 * フォグ帯（`gen2-sfc.ts` の FOG_BANDS）も同じ重ね方で乗せる。遠方がどれだけ
 * 霞んで見えるかが、遠クリップとタイル数の判断に直結するため。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';

import { TRACK } from '../src/game/sim/track.ts';
import { SFC_ROAD_MAP, roadMapProjection } from '../src/game/view/shared/road-map.ts';
import { SFC_CAMERA, SFC_DRAW_DISTANCE, createRoadView } from '../src/game/view/shared/projection.ts';
import { roadSurfaceFor } from '../src/game/view/shared/road-surface.ts';
import { decodePng, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PROFILE = HARDWARE_GENERATION_PROFILES.SFC;
const WIDTH = PROFILE.video.internalWidth;
const HEIGHT = PROFILE.video.internalHeight;

/** `gen2-sfc.ts` と同じフォグ。手前の帯ほど路面に近い固定色 */
const FOG_BANDS = [
  { distance: 40, color: [0x60, 0x70, 0x68] },
  { distance: 60, color: [0x78, 0x90, 0x98] },
  { distance: 90, color: [0x88, 0xb0, 0xc8] },
  { distance: 150, color: [0x88, 0xb8, 0xd8] },
];
const SKY = [0x88, 0xb8, 0xd8];

const map = decodePng(readFileSync(join(repoRoot, `public/${SFC_ROAD_MAP.texture}`)));
const projection = roadMapProjection(TRACK.bounds, SFC_ROAD_MAP);
if (map.width !== projection.width || map.height !== projection.height) {
  throw new Error('マップの画素数が road-map.ts の定義と食い違う（先に build:road-map）');
}

function frameAt(s, lateral = 0) {
  const view = createRoadView({
    profile: PROFILE,
    camera: SFC_CAMERA,
    track: TRACK,
    car: {
      entrant: 0, s, lateral, yaw: 0, speed: 60, standing: 1, lap: 1, offTrack: false,
      lateralAccel: 0, longitudinalAccel: 0, lapStartTick: 0, bestLapTicks: -1, finished: false,
    },
    layout: roadSurfaceFor('SFC'),
    maxDistance: SFC_DRAW_DISTANCE,
  });
  const origin = TRACK.sampleAt(view.originS);
  const camera = TRACK.toWorld(view.originS, view.originLateral);
  const [fx, fz] = origin.tangent;
  const [rx, rz] = origin.right;

  const pixels = Buffer.alloc(WIDTH * HEIGHT * 4);
  for (let row = 0; row < HEIGHT; row++) {
    const above = row < SFC_CAMERA.roadTopRow;
    const raw = view.distanceAtRow(row + 0.5);
    const z = Math.min(SFC_ROAD_MAP.farClip, raw);
    const metersPerPixel = z / SFC_CAMERA.focal;
    // 何枚のフォグ帯がこの行に掛かるか（クリップ前の距離で決める）
    const fog = FOG_BANDS.filter((band) => raw > band.distance);

    for (let x = 0; x < WIDTH; x++) {
      let color = SKY;
      if (!above) {
        const offset = (x + 0.5 - WIDTH / 2) * metersPerPixel;
        const worldX = camera[0] + fx * z + rx * offset;
        const worldZ = camera[2] + fz * z + rz * offset;
        const u = Math.round((worldX - projection.originX) * projection.texelsPerMeter - 0.5);
        const v = Math.round((worldZ - projection.originZ) * projection.texelsPerMeter - 0.5);
        const cx = Math.min(map.width - 1, Math.max(0, u));
        const cy = Math.min(map.height - 1, Math.max(0, v));
        const at = (cy * map.width + cx) * 4;
        color = [map.pixels[at], map.pixels[at + 1], map.pixels[at + 2]];
      }
      // color math の add half を帯のぶんだけ重ねる
      let [r, g, b] = color;
      for (const band of fog) {
        r = (r + band.color[0]) / 2;
        g = (g + band.color[1]) / 2;
        b = (b + band.color[2]) / 2;
      }
      const to = (row * WIDTH + x) * 4;
      pixels[to] = Math.round(r);
      pixels[to + 1] = Math.round(g);
      pixels[to + 2] = Math.round(b);
      pixels[to + 3] = 255;
    }
  }
  return pixels;
}

/** 目視用に整数倍で拡大し、複数フレームを横に並べる */
function contactSheet(frames, zoom) {
  const width = WIDTH * zoom * frames.length;
  const height = HEIGHT * zoom;
  const pixels = Buffer.alloc(width * height * 4);
  frames.forEach((frame, index) => {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < WIDTH * zoom; x++) {
        const from = (Math.floor(y / zoom) * WIDTH + Math.floor(x / zoom)) * 4;
        const to = (y * width + index * WIDTH * zoom + x) * 4;
        frame.copy(pixels, to, from, from + 4);
      }
    }
  });
  return encodePng(width, height, pixels);
}

const positions = process.argv.slice(2).map(Number);
const shots = (positions.length > 0 ? positions : [0, 700, 1150, 1400, 2100]).map((s) => frameAt(s));
const output = process.env.FRAME_OUT ?? 'gen2-map-frame.png';
writeFileSync(resolve(repoRoot, output), contactSheet(shots, Number(process.env.FRAME_ZOOM ?? 2)));
console.log(`${shots.length} フレーム → ${output}`);
