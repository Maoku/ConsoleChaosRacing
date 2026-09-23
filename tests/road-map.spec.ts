import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import { VEHICLE } from '../src/game/sim/vehicle.js';
import {
  SFC_ROAD_MAP,
  roadMapProjection,
  roadMapWindow,
  tileMeters,
  windowMeters,
} from '../src/game/view/shared/road-map.js';
import { SFC_CAMERA, SFC_DRAW_DISTANCE, createRoadView } from '../src/game/view/shared/projection.js';
import { roadSurfaceFor } from '../src/game/view/shared/road-surface.js';
import { decodePng } from '../tools/lib/png.mjs';

/**
 * コースマップが実機の Mode 7 面に載るか（実装計画 §3.3 の改善案 / 8-2）。
 *
 * マップはコース全体（3080×2096 px）を 1 枚に持つが、**実機の面は 1024×1024 px・
 * タイルの実体 256 種**しかない。当時は VBlank の DMA でタイルマップを書き換えながら
 * 走らせていた（VRAM に載るのは常にカメラ周辺だけ）。その「VRAM の中身」を窓として、
 * ここで 3 つの門を掛ける。実行時にストリーム処理は無く、**窓に収まることを
 * このテストが担保する**という構成になっている。
 *
 *   1. 1 フレームで引く地面が必ず 1 つの窓に収まる
 *   2. 窓の中のユニーク 8×8 タイルが 256 種以内
 *   3. 窓が動くとき 1 フレームに入れ替わるエントリ数が DMA 予算以内
 */

const PROFILE = HARDWARE_GENERATION_PROFILES.SFC;
const LAYOUT = roadSurfaceFor('SFC')!;
const PROJECTION = roadMapProjection(TRACK.bounds, SFC_ROAD_MAP);
const TILE = tileMeters(SFC_ROAD_MAP);
const WINDOW_TILES = SFC_ROAD_MAP.windowPixels / SFC_ROAD_MAP.tileGrid.size;

function displayCar(s: number, lateral: number) {
  return {
    entrant: 0,
    s,
    lateral,
    yaw: 0,
    speed: VEHICLE.MAX_SPEED,
    standing: 1,
    lap: 1,
    offTrack: false,
    lateralAccel: 0,
    longitudinalAccel: 0,
    brakeInput: 0,
    lapStartTick: 0,
    bestLapTicks: -1,
    finished: false,
  };
}

/** 視点の位置・前方・右方向（`affine-surface.ts` がマップを引くときと同じ取り方） */
function eye(s: number, lateral: number) {
  const view = createRoadView({
    profile: PROFILE,
    camera: SFC_CAMERA,
    track: TRACK,
    car: displayCar(s, lateral),
    layout: LAYOUT,
    maxDistance: SFC_DRAW_DISTANCE,
  });
  const origin = TRACK.sampleAt(view.originS);
  const position = TRACK.toWorld(view.originS, view.originLateral);
  return { view, position, forward: origin.tangent, right: origin.right };
}

/**
 * 1 フレームで地面を引く点（各走査線の左端・中央・右端）。
 * 距離は `farClip` で止める — 下り坂では最上行が 358 m 先まで見るため。
 */
function footprint(s: number, lateral: number): [number, number][] {
  const { view, position, forward, right } = eye(s, lateral);
  const points: [number, number][] = [];
  for (let row = SFC_CAMERA.roadTopRow; row < PROFILE.video.internalHeight; row++) {
    const distance = Math.min(SFC_ROAD_MAP.farClip, view.distanceAtRow(row + 0.5));
    if (!Number.isFinite(distance)) continue;
    const half = (distance / SFC_CAMERA.focal) * (PROFILE.video.internalWidth / 2);
    for (const offset of [-half, 0, half]) {
      points.push([
        position[0] + forward[0] * distance + right[0] * offset,
        position[2] + forward[1] * distance + right[1] * offset,
      ]);
    }
  }
  return points;
}

/** 視点に対応する窓（タイル座標の矩形） */
function windowAt(s: number, lateral: number) {
  const { view, position, forward, right } = eye(s, lateral);
  const rows = PROFILE.video.internalHeight;
  const [left, top] = roadMapWindow(PROJECTION, SFC_ROAD_MAP, {
    cameraX: position[0],
    cameraZ: position[2],
    forwardX: forward[0],
    forwardZ: forward[1],
    rightX: right[0],
    rightZ: right[1],
    near: view.distanceAtRow(rows - 0.5),
    far: Math.min(SFC_ROAD_MAP.farClip, view.distanceAtRow(SFC_CAMERA.roadTopRow + 0.5)),
    spread: PROFILE.video.internalWidth / 2 / SFC_CAMERA.focal,
  });
  return { left, top };
}

/** コース 1 周をまんべんなく見る。横位置はコース外（復帰中）も含める */
const MOMENTS: number[] = [];
for (let s = 0; s < TRACK.length; s += 5) MOMENTS.push(s);
const LATERALS = [-11, 0, 11];

describe('コースマップ（第2世代の Mode 7 面）', () => {
  it('マップの画素数が road-map.ts の定義と一致する', () => {
    const image = decodePng(readFileSync(join(process.cwd(), 'public', SFC_ROAD_MAP.texture)));
    expect([image.width, image.height]).toEqual([PROJECTION.width, PROJECTION.height]);
    // コースの外接矩形＋余白が入っていること
    expect(image.width / SFC_ROAD_MAP.texelsPerMeter).toBeGreaterThan(
      TRACK.bounds.size[0] + SFC_ROAD_MAP.marginMeters * 2,
    );
  });

  it('マップの外周が単色（clamp がコース外へその色を伸ばせる）', () => {
    const image = decodePng(readFileSync(join(process.cwd(), 'public', SFC_ROAD_MAP.texture)));
    const at = (x: number, y: number) => {
      const offset = (y * image.width + x) * 4;
      return [image.pixels[offset], image.pixels[offset + 1], image.pixels[offset + 2]].join(',');
    };
    const corner = at(0, 0);
    for (let x = 0; x < image.width; x++) {
      expect(at(x, 0), `上端 x=${x}`).toBe(corner);
      expect(at(x, image.height - 1), `下端 x=${x}`).toBe(corner);
    }
    for (let y = 0; y < image.height; y++) {
      expect(at(0, y), `左端 y=${y}`).toBe(corner);
      expect(at(image.width - 1, y), `右端 y=${y}`).toBe(corner);
    }
  });

  it('1 フレームで引く地面が 1024×1024 の窓に収まる', () => {
    // 60 万点を見るので、expect は「いちばんはみ出した 1 点」に対して 1 回だけ掛ける
    let worst = Number.NEGATIVE_INFINITY;
    let worstAt = '';
    for (const s of MOMENTS) {
      for (const lateral of LATERALS) {
        const { left, top } = windowAt(s, lateral);
        for (const [x, z] of footprint(s, lateral)) {
          const tileX = (x - PROJECTION.originX) / TILE - left;
          const tileZ = (z - PROJECTION.originZ) / TILE - top;
          // 窓の内側にいるほど小さい値。0 が窓の縁
          const outside = Math.max(-tileX, tileX - WINDOW_TILES, -tileZ, tileZ - WINDOW_TILES);
          if (outside > worst) {
            worst = outside;
            worstAt = `s=${s.toFixed(0)} lateral=${lateral}`;
          }
        }
      }
    }
    expect(worst, `${worstAt} で窓から ${worst.toFixed(2)} タイルはみ出した`).toBeLessThanOrEqual(0);
    // 余裕がどれだけ残っているかも固定する（窓 288 m に対しフットプリントは 267 m）
    expect(-worst).toBeLessThan(WINDOW_TILES / 2);
  });

  it('タイルの実体が 256 種以内（＝キャラクタは常駐でよい）', () => {
    const image = decodePng(readFileSync(join(process.cwd(), 'public', SFC_ROAD_MAP.texture)));
    const size = SFC_ROAD_MAP.tileGrid.size;
    const tiles = new Set<string>();
    for (let tileY = 0; tileY < image.height / size; tileY++) {
      for (let tileX = 0; tileX < image.width / size; tileX++) {
        const bytes: number[] = [];
        for (let y = 0; y < size; y++) {
          const from = ((tileY * size + y) * image.width + tileX * size) * 4;
          for (let index = 0; index < size * 4; index++) bytes.push(image.pixels[from + index]!);
        }
        tiles.add(bytes.join(','));
      }
    }
    // 全体で 256 種に収まっているので、どの窓を切り出しても必ず 256 種以内になる
    expect(tiles.size).toBeLessThanOrEqual(SFC_ROAD_MAP.tileGrid.maxUniqueTiles);
  });

  it('全画素が RGB555 の格子（各チャンネル 8 の倍数）に載っている', () => {
    const image = decodePng(readFileSync(join(process.cwd(), 'public', SFC_ROAD_MAP.texture)));
    // 画素ごとに expect を呼ぶと 650 万回になるので、外れた値だけを集めて 1 回で見る
    const offenders = new Set<number>();
    for (let index = 0; index < image.width * image.height; index++) {
      const offset = index * 4;
      for (let channel = 0; channel < 3; channel++) {
        const value = image.pixels[offset + channel]!;
        if (value % 8 !== 0) offenders.add(value);
      }
    }
    expect([...offenders]).toEqual([]);
  });

  it('窓が動く速さが VBlank の DMA 予算に収まる', () => {
    // 実機は 60Hz で VRAM を書き換える。最高速で 1 周し、1 フレームあたりの移動を見る
    const step = VEHICLE.MAX_SPEED / 60;
    let worstEntries = 0;
    let worstAt = 0;
    let previous = windowAt(0, 0);
    for (let s = step; s < TRACK.length; s += step) {
      const current = windowAt(s, 0);
      // 入れ替わるのは動いた列と行のぶん（1 エントリ 1 byte）
      const entries =
        (Math.abs(current.left - previous.left) + Math.abs(current.top - previous.top)) *
        WINDOW_TILES;
      if (entries > worstEntries) {
        worstEntries = entries;
        worstAt = s;
      }
      previous = current;
    }
    expect(worstEntries, `s=${worstAt} で ${worstEntries} byte/frame`).toBeLessThanOrEqual(
      SFC_ROAD_MAP.dmaBytesPerFrame,
    );
  });

  it('窓の広さがフットプリントより広く、密度が帯テクスチャと同程度に保たれている', () => {
    // 窓を狭くするほど texel/m は上がるが、フットプリント（遠クリップ 260 m で 277 m）
    // が入らなくなる。この 2 つの釣り合いが密度を決めている
    expect(windowMeters(SFC_ROAD_MAP)).toBeGreaterThan(267);
    expect(SFC_ROAD_MAP.texelsPerMeter).toBeGreaterThan(LAYOUT.textureHeight / LAYOUT.periodMeters);
  });
});
