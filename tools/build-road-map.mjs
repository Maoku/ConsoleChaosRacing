#!/usr/bin/env tsx
/**
 * 第2世代のコースマップ（真の Mode 7 — 実装計画 §3.3 の改善案）。
 *
 *   npm run build:road-map
 *
 * `road_affine.png` が「直線路 1 本の帯」だったのに対し、これは**コース全体を
 * 真上から見た 1 枚**である。アフィン面の UV がワールド XZ の写像そのものになるので、
 * コーナーでは視界が演出ではなく投影の帰結として回る。
 *
 * ## 実機との対応
 *
 * 実機の Mode 7 面は 1024×1024 px・タイルの実体 256 種しか無く、コース全体は載らない。
 * 当時は VBlank の DMA でタイルマップを書き換えながら走らせていた（VRAM に載るのは
 * 常にカメラ周辺だけ）。ここではその「VRAM の中身」を**窓**として定義し、
 * 窓に収まっていることをテスト（`road-map.spec.ts`）で担保する。定義は
 * `src/game/view/shared/road-map.ts` にあり、このツールと実行時が共有する。
 *
 * ## 断面の定義は共有する
 *
 * 路面幅・縁石・破線の寸法は `road-surface.ts` の `roadSurfaceColorAt` 1 か所にある。
 * 帯テクスチャ（`build-road-texture.mjs`）と**同じ関数**を通すので、
 * 第2世代の中で 2 つの路面の見た目が食い違うことが構造的に起きない。
 * 違いは「どの (lateral, along) を引くか」だけ — 帯は格子、マップはコースの形。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TRACK } from '../src/game/sim/track.ts';
import {
  SFC_ROAD_MAP,
  roadMapProjection,
  roadMapSurface,
  tileMeters,
  windowMeters,
} from '../src/game/view/shared/road-map.ts';
import {
  patternPeriodMeters,
  roadSurfaceColorAt,
  roadSurfaceFor,
  roadSurfaceSpanMeters,
} from '../src/game/view/shared/road-surface.ts';
import { downscaleBox, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** '#rrggbb' → [r, g, b] */
function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * 模様の位相をスタート/フィニッシュラインで閉じるための倍率。
 *
 * 破線と縁石の縞は `patternPeriodMeters` ごとの繰り返しだが、1 周の長さは
 * その整数倍ではない。マップは**コース全体を 1 枚に焼く**ので、帯テクスチャと違って
 * 継ぎ目が絵として残る。周期を 1 周に整数回入るよう 0.2% ほど伸縮させて閉じる。
 */
function patternScale(layout) {
  const period = patternPeriodMeters(layout);
  const cycles = Math.max(1, Math.round(TRACK.length / period));
  return (cycles * period) / TRACK.length;
}

/**
 * コースマップを焼く。
 *
 * 中心線のサンプル（1 m 間隔）ごとに、その断面が届くタイルを拾う。スラブは前後に
 * 半サンプルぶんだが**曲率のぶんだけ外側で開く**ので、開く量
 * `|lateral| · |curvature| · spacing / 2` を足して重ねる。重なったタイルは
 * **中心線に近いほうが勝つ** ＝ 折り返しでコースが接近する場所でも最近傍の断面が引かれる。
 *
 * タイルの中身は量子化した (θ, e, a) から**その場で 1 枚だけ焼いて使い回す**。
 * 同じ 3 つ組のタイルは必ずバイト一致するので、語彙は自然に閉じる。
 *
 * `e` は `roadSurfaceColorAt` が舗装の広い区間で行う写像を通したあとの距離にしてある。
 * こうしておくと**路面半幅（6〜7 m）が語彙の次元にならない** — 広い区間の縁石は、
 * 外へずれた同じタイルとして共有される。
 */
function render(layout, mapLayout) {
  const projection = roadMapProjection(TRACK.bounds, mapLayout);
  const { width, height, originX, originZ, texelsPerMeter } = projection;
  const size = mapLayout.tileGrid.size;
  const tilesX = width / size;
  const tilesY = height / size;
  const scale = patternScale(layout);
  const spacing = TRACK.spacing;
  const tile = size / texelsPerMeter;
  const radius = (tile * Math.SQRT2) / 2;

  const palette = new Map();
  const toRgb = (hex) => {
    let value = palette.get(hex);
    if (!value) {
      value = rgb(hex);
      palette.set(hex, value);
    }
    return value;
  };

  /** タイルごとに選ばれた断面。`lateral` は最寄りの中心線までの符号付き距離 */
  const chosen = new Float64Array(tilesX * tilesY * 3);
  const nearest = new Float32Array(tilesX * tilesY).fill(Number.POSITIVE_INFINITY);
  const baseSpan = roadSurfaceSpanMeters(layout);

  for (const sample of TRACK.samples) {
    const [cx, , cz] = sample.position;
    const [tx, tz] = sample.tangent;
    const [rx, rz] = sample.right;
    const span = baseSpan + (sample.halfWidth - layout.roadHalfWidth);
    const reach = spacing / 2 + span * Math.abs(sample.curvature) * (spacing / 2) + radius;

    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (const along of [-reach, reach]) {
      for (const lateral of [-span - radius, span + radius]) {
        const x = cx + tx * along + rx * lateral;
        const z = cz + tz * along + rz * lateral;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (z < minZ) minZ = z;
        if (z > maxZ) maxZ = z;
      }
    }
    const fromX = Math.max(0, Math.floor((minX - originX) / tile));
    const toX = Math.min(tilesX - 1, Math.ceil((maxX - originX) / tile));
    const fromY = Math.max(0, Math.floor((minZ - originZ) / tile));
    const toY = Math.min(tilesY - 1, Math.ceil((maxZ - originZ) / tile));

    for (let ty = fromY; ty <= toY; ty++) {
      const worldZ = originZ + (ty + 0.5) * tile;
      const dz = worldZ - cz;
      for (let tx2 = fromX; tx2 <= toX; tx2++) {
        const worldX = originX + (tx2 + 0.5) * tile;
        const dx = worldX - cx;
        const lateral = dx * rx + dz * rz;
        const distance = Math.abs(lateral);
        if (distance > span + radius) continue;
        const index = ty * tilesX + tx2;
        if (distance >= nearest[index]) continue;
        const along = dx * tx + dz * tz;
        if (Math.abs(along) > reach) continue;

        nearest[index] = distance;
        // 断面の距離は `roadSurfaceColorAt` の写像を通したあとの値で持つ
        const raw = distance;
        const mapped =
          raw <= sample.halfWidth
            ? (raw * layout.roadHalfWidth) / sample.halfWidth
            : raw - (sample.halfWidth - layout.roadHalfWidth);
        chosen[index * 3] = Math.sign(lateral) * mapped;
        chosen[index * 3 + 1] = (sample.s + along) * scale;
        chosen[index * 3 + 2] = Math.atan2(tz, tx);
      }
    }
  }

  const pixels = Buffer.alloc(width * height * 4);
  const outside = toRgb(layout.colors.grass[layout.colors.grass.length - 1].color);
  const cache = new Map();
  /** 量子化で生まれた候補タイル（この段階ではまだ 256 種に収まっていない） */
  const candidates = [];
  const candidateCounts = [];
  const rasters = new Map();
  const angleStep = (Math.PI * 2) / mapLayout.quantize.angles;
  const lateralStep = mapLayout.quantize.lateralTexels / texelsPerMeter;
  const alongStep = mapLayout.quantize.alongTexels / texelsPerMeter;
  const patternPeriod = patternPeriodMeters(layout);

  /** 量子化した 3 つ組から 8×8 タイルを焼く（同じ 3 つ組なら必ず同じ絵） */
  function tileFor(lateral, along, angle) {
    const eq = Math.round(lateral / lateralStep) * lateralStep;
    // 位相は 1 周期の剰余でしか意味を持たない。剰余を取ってから刻む
    const wrapped = along - Math.floor(along / patternPeriod) * patternPeriod;
    const aq = Math.round(wrapped / alongStep) * alongStep;
    const angleIndex = Math.round(angle / angleStep);
    const key = `${Math.round(eq / lateralStep)},${Math.round(aq / alongStep)},${angleIndex}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const theta = angleIndex * angleStep;
    const tangent = [Math.cos(theta), Math.sin(theta)];
    // right は tangent を +90° 回した向き（`track.ts` の規約と同じ）
    const right = [-tangent[1], tangent[0]];
    const bytes = Buffer.alloc(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const offsetX = (x + 0.5 - size / 2) / texelsPerMeter;
        const offsetZ = (y + 0.5 - size / 2) / texelsPerMeter;
        const [red, green, blue] = toRgb(
          roadSurfaceColorAt(
            layout,
            eq + offsetX * right[0] + offsetZ * right[1],
            aq + offsetX * tangent[0] + offsetZ * tangent[1],
          ),
        );
        const at = (y * size + x) * 4;
        bytes[at] = red;
        bytes[at + 1] = green;
        bytes[at + 2] = blue;
        bytes[at + 3] = 255;
      }
    }
    // 同じ絵になった 3 つ組は 1 つの候補へまとめる
    const raster = bytes.toString('base64');
    let index = rasters.get(raster);
    if (index === undefined) {
      index = candidates.length;
      rasters.set(raster, index);
      candidates.push(bytes);
      candidateCounts.push(0);
    }
    cache.set(key, index);
    return index;
  }

  // コースから離れたタイルは最も外側の草地 1 種。これが候補 0 番になる
  const solid = Buffer.alloc(size * size * 4);
  for (let index = 0; index < size * size; index++) {
    solid[index * 4] = outside[0];
    solid[index * 4 + 1] = outside[1];
    solid[index * 4 + 2] = outside[2];
    solid[index * 4 + 3] = 255;
  }
  rasters.set(solid.toString('base64'), 0);
  candidates.push(solid);
  candidateCounts.push(0);

  const assignment = new Int32Array(tilesX * tilesY);
  for (let index = 0; index < tilesX * tilesY; index++) {
    const candidate = Number.isFinite(nearest[index])
      ? tileFor(chosen[index * 3], chosen[index * 3 + 1], chosen[index * 3 + 2])
      : 0;
    assignment[index] = candidate;
    candidateCounts[candidate]++;
  }

  const vocabulary = reduceVocabulary(candidates, candidateCounts, mapLayout.tileGrid.maxUniqueTiles);
  for (let ty = 0; ty < tilesY; ty++) {
    for (let tx2 = 0; tx2 < tilesX; tx2++) {
      const bytes = vocabulary.tiles[vocabulary.remap[assignment[ty * tilesX + tx2]]];
      for (let y = 0; y < size; y++) {
        const to = ((ty * size + y) * width + tx2 * size) * 4;
        bytes.copy(pixels, to, y * size * 4, (y + 1) * size * 4);
      }
    }
  }

  return {
    projection,
    pixels,
    colors: palette.size,
    candidates: candidates.length,
    vocabulary: vocabulary.tiles.length,
    error: vocabulary.error,
    peak: vocabulary.peak,
  };
}

/**
 * 候補タイルを実体 256 種の語彙へ落とす（実装計画 8-2）。
 *
 * 幾何の量子化だけで 256 種まで落とそうとすると向きを 45° 刻みにするしかなくなり、
 * **縁石（3 texel）と白線（1 texel）が角ごとにちぎれる**。細い模様は位置の量子化に
 * 耐えられない。そこで幾何は細かいまま焼き、**絵として近いタイルを束ねる**。
 *
 * 束ね方は**マップ全体の誤差をいちばん減らす 1 枚**を毎回採る貪欲法にする。
 * 評価は「いまの代表からの二乗誤差 × そのタイルがマップに現れる枚数」。
 *
 * 枚数を掛けないと（純粋な最遠点）、語彙がまれで極端なタイルに食い潰され、
 * **舗装の内側が縁石入りのタイルに化ける** — 実際にそうなった。逆によく出る順に
 * 採って閾値で切る作法だと、まれなタイルが遠い代表へ落ちて同じことが起きる。
 * 枚数で重み付けした最遠点なら、まず路面・草地といった無地が正確に採られ、
 * 残りの枠が縁石や白線の角度違いへ回る。
 *
 * 最初の 1 枚はコース外の草地（候補 0 番）に固定し、以降は毎回 スコア最大 → 同点は
 * 若い番号、と決めてあるので二度実行してバイト一致する。
 */
function reduceVocabulary(candidates, counts, maxTiles) {
  const size = Math.round(Math.sqrt(candidates[0].length / 4));
  const pixels = size * size;

  function difference(a, b) {
    let total = 0;
    for (let index = 0; index < pixels; index++) {
      const at = index * 4;
      const dr = a[at] - b[at];
      const dg = a[at + 1] - b[at + 1];
      const db = a[at + 2] - b[at + 2];
      total += dr * dr + dg * dg + db * db;
    }
    return total;
  }

  const nearest = new Float64Array(candidates.length).fill(Number.POSITIVE_INFINITY);
  const owner = new Int32Array(candidates.length);
  const leaders = [];

  const adopt = (leader) => {
    leaders.push(leader);
    for (let index = 0; index < candidates.length; index++) {
      const value = difference(candidates[index], candidates[leader]);
      if (value < nearest[index]) {
        nearest[index] = value;
        owner[index] = leader;
      }
    }
  };

  adopt(0);
  while (leaders.length < maxTiles) {
    let worst = -1;
    let worstScore = 0;
    for (let index = 0; index < candidates.length; index++) {
      const score = nearest[index] * counts[index];
      if (score > worstScore) {
        worstScore = score;
        worst = index;
      }
    }
    if (worst < 0) break;
    adopt(worst);
  }

  const indices = new Map(leaders.map((leader, index) => [leader, index]));
  const remap = new Int32Array(candidates.length);
  let total = 0;
  let weight = 0;
  let peak = 0;
  for (let index = 0; index < candidates.length; index++) {
    remap[index] = indices.get(owner[index]);
    total += nearest[index] * counts[index];
    weight += counts[index] * pixels * 3;
    peak = Math.max(peak, nearest[index]);
  }
  return {
    tiles: leaders.map((leader) => candidates[leader]),
    remap,
    error: Math.sqrt(total / Math.max(1, weight)),
    peak: Math.sqrt(peak / (pixels * 3)),
  };
}

/** 8×8 タイルへ切り、同じ絵のタイルへ同じ番号を振る */
function tileIndices(pixels, width, height, size) {
  if (width % size !== 0 || height % size !== 0) {
    throw new Error(`${width}×${height} を ${size} px タイルで割り切れない`);
  }
  const tilesX = width / size;
  const tilesY = height / size;
  const ids = new Int32Array(tilesX * tilesY);
  const seen = new Map();
  const bytes = Buffer.alloc(size * size * 4);

  for (let tileY = 0; tileY < tilesY; tileY++) {
    for (let tileX = 0; tileX < tilesX; tileX++) {
      for (let y = 0; y < size; y++) {
        const from = ((tileY * size + y) * width + tileX * size) * 4;
        pixels.copy(bytes, y * size * 4, from, from + size * 4);
      }
      const key = bytes.toString('base64');
      let id = seen.get(key);
      if (id === undefined) {
        id = seen.size;
        seen.set(key, id);
      }
      ids[tileY * tilesX + tileX] = id;
    }
  }
  return { ids, tilesX, tilesY, unique: seen.size };
}

/**
 * どの窓（＝ VRAM に載る Mode 7 面）にユニークタイルが何種入るかを数える。
 * 実機に載るかどうかは**全体の種類数ではなく、同時に見える窓の中の種類数**で決まる。
 */
function worstWindow(grid, windowTiles) {
  const { ids, tilesX, tilesY } = grid;
  if (tilesX < windowTiles || tilesY < windowTiles) {
    throw new Error(`マップ ${tilesX}×${tilesY} タイルが窓 ${windowTiles} より小さい`);
  }
  const counts = new Int32Array(grid.unique);
  let distinct = 0;
  let worst = 0;
  let worstAt = [0, 0];

  const add = (id) => {
    if (counts[id]++ === 0) distinct++;
  };
  const remove = (id) => {
    if (--counts[id] === 0) distinct--;
  };

  for (let top = 0; top + windowTiles <= tilesY; top++) {
    counts.fill(0);
    distinct = 0;
    for (let y = top; y < top + windowTiles; y++) {
      for (let x = 0; x < windowTiles; x++) add(ids[y * tilesX + x]);
    }
    if (distinct > worst) {
      worst = distinct;
      worstAt = [0, top];
    }
    for (let left = 1; left + windowTiles <= tilesX; left++) {
      for (let y = top; y < top + windowTiles; y++) {
        remove(ids[y * tilesX + left - 1]);
        add(ids[y * tilesX + left + windowTiles - 1]);
      }
      if (distinct > worst) {
        worst = distinct;
        worstAt = [left, top];
      }
    }
  }
  return { worst, worstAt };
}

const layout = roadMapSurface(roadSurfaceFor('SFC'));
const mapLayout = SFC_ROAD_MAP;
const { projection, pixels, colors, candidates, vocabulary, error, peak } = render(layout, mapLayout);
const { width, height } = projection;

console.log(
  `コースマップ ${width}×${height} px / ${mapLayout.texelsPerMeter.toFixed(3)} texel/m` +
    ` / 1 タイル ${tileMeters(mapLayout).toFixed(2)} m / 窓 ${windowMeters(mapLayout).toFixed(0)} m`,
);
console.log(
  `  路面 ${(layout.roadHalfWidth * 2 * mapLayout.texelsPerMeter).toFixed(0)} texel` +
    ` / 縁石 ${(layout.kerbWidth * mapLayout.texelsPerMeter).toFixed(1)} texel` +
    ` / 白線 ${(layout.lineWidth * mapLayout.texelsPerMeter).toFixed(1)} texel / 色数 ${colors}`,
);

const grid = tileIndices(pixels, width, height, mapLayout.tileGrid.size);
const windowTiles = mapLayout.windowPixels / mapLayout.tileGrid.size;
const { worst, worstAt } = worstWindow(grid, windowTiles);
console.log(
  `  候補 ${candidates} 種 → 語彙 ${vocabulary} 種（RMS 誤差 ${error.toFixed(1)}・最悪 ${peak.toFixed(1)}）` +
    ` / 全体 ${grid.unique} 種 / 窓の最悪 ${worst} 種` +
    `（上限 ${mapLayout.tileGrid.maxUniqueTiles}・タイル ${grid.tilesX}×${grid.tilesY}・最悪の窓 ${worstAt}）`,
);

const png = encodePng(width, height, pixels);
const absolute = join(repoRoot, `public/${mapLayout.texture}`);
mkdirSync(dirname(absolute), { recursive: true });
writeFileSync(absolute, png);
console.log(`  → public/${mapLayout.texture}（${(png.length / 1024).toFixed(0)} KB）`);

// 目視用の縮小版。リポジトリには入れない
if (process.env.ROAD_MAP_PREVIEW) {
  const factor = Number(process.env.ROAD_MAP_PREVIEW);
  const cropWidth = Math.floor(width / factor) * factor;
  const cropHeight = Math.floor(height / factor) * factor;
  const cropped = Buffer.alloc(cropWidth * cropHeight * 4);
  for (let y = 0; y < cropHeight; y++) {
    pixels.copy(cropped, y * cropWidth * 4, y * width * 4, y * width * 4 + cropWidth * 4);
  }
  const small = downscaleBox({ width: cropWidth, height: cropHeight, pixels: cropped }, factor);
  writeFileSync(
    resolve(repoRoot, process.env.ROAD_MAP_PREVIEW_PATH ?? 'road-map-preview.png'),
    encodePng(small.width, small.height, small.pixels),
  );
}
