#!/usr/bin/env tsx
/**
 * 車スプライトのアトラス整形とパレット替え（実装計画 §3.2 / §2.6 / 11-1）。
 *
 *   npm run build:sprites
 *
 * ## 整形（第1・第2世代の共通）
 *
 * 同梱の `cars.png` は 3 列 × 2 行のつもりで作られているが、**絵がセルの境界を
 * 2 px はみ出している**。左傾きの車は右隣のセルへ、右傾きの車は左隣のセルから
 * 食い込んでおり、正面のセルを描くと両端に隣の車の破片が 1 px ずつ現れる。
 * 画面では自機の左右に小さな赤い点として出る（実際に第1世代の画面で確認した）。
 *
 * そこで絵を連結成分ごとに切り出し、**セルの中央へ・接地線を揃えて**焼き直す。
 * あわせて、車ごとにばらついていた接地線の位置が 1 つの定数になるので、
 * `car-sprite.ts` の実測表も 1 行で済むようになる。
 *
 * ## パレット替え（第2世代だけ・11-1 / D-1）
 *
 * 実機のスプライトは **1 タイルセット + パレット 16 色**で、色違いの敵車は
 * パレット番号を変えて作った。ここでもそれに倣い、**絵（インデックス地図）は 1 つ・
 * パレットだけ 8 種**を焼く。実行時の乗算（`SpriteCommand.color`）は使わない —
 * 元絵が赤なので緑を掛けると黒く沈み、タイヤや窓まで染まる。
 *
 * どの色が「塗装」でどの色が「共通部品」かは、**元絵そのものが教えてくれる**。
 * 同梱の `cars.png` は同じ絵を黄（自機）と赤（ライバル）で 2 度描いたもので、
 * 2 行はほぼ画素単位で揃っている（13,544 画素が重なり、食い違いは 109 画素）。
 * **2 行で色が変わる画素が塗装・変わらない画素がタイヤ / 窓 / 影 / 灯火**である。
 * 彩度で分けると赤いテールランプが塗装側へ落ちてしまうので、この差分で分ける。
 *
 * 元の `cars.png` は残す（`data/` と同じく入力は書き換えない）。
 * 二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CAR_SPRITE_GEOMETRY,
  CAR_SPRITE_SOURCES,
} from '../src/game/view/shared/car-sprite.ts';
import { ENTRANT_COLORS } from '../src/game/view/shared/variants.ts';
import { decodePng, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 不透明とみなす alpha の下限 */
const OPAQUE = 8;

/**
 * 自機の行とライバルの行の色差がこれ以下なら「塗装で変わらない画素」とみなす。
 * 24（チャンネル差の合計）で共有 5,406 画素・塗装 8,220 画素に分かれる。
 */
const SHARED_DIFF = 24;

/**
 * パレットの内訳。透明 1 + 塗装 7 + 共有 8 = 16 色（実機のスプライト 1 パレット）。
 * 8 台ぶんの固有色は 7 × 8 + 8 = **64 色**で、§4.2 の予算 66 色に収まる。
 */
const PALETTE = { body: 7, shared: 8 };

/** 絵のある列を連結成分ごとにまとめる。列 3 本ぶんの [開始, 終了] が返る */
function columnRuns(image) {
  const runs = [];
  let start = -1;
  for (let x = 0; x < image.width; x++) {
    let used = false;
    for (let y = 0; y < image.height && !used; y++) {
      used = image.pixels[(y * image.width + x) * 4 + 3] >= OPAQUE;
    }
    if (used && start < 0) start = x;
    if (!used && start >= 0) {
      runs.push([start, x - 1]);
      start = -1;
    }
  }
  if (start >= 0) runs.push([start, image.width - 1]);
  return runs;
}

/**
 * 矩形 `[left, right] × [top, bottom)` のなかで絵のある行の範囲。
 *
 * **絵 1 つずつに掛ける。** 帯（行）全体でまとめて採ると、車ごとに 1 px ずれている
 * 元絵（第2世代の正面がそう）で接地線が揃わず、傾けたときに車が浮き沈みする。
 */
function rowExtent(image, left, right, top, bottom) {
  let first = -1;
  let last = -1;
  for (let y = top; y < bottom; y++) {
    let used = false;
    for (let x = left; x <= right && !used; x++) {
      used = image.pixels[(y * image.width + x) * 4 + 3] >= OPAQUE;
    }
    if (used) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return [first, last];
}

/**
 * 元絵の 1 帯（自機 or ライバル）を、セルの中央・接地線を揃えて焼き直す。
 * 返すのは 1 行ぶん（`columns × cell` 幅 × `cell` 高さ）の RGBA。
 */
function reshapeBand(image, runs, layout, band) {
  const { columns, cell, groundFraction } = layout;
  const width = cell * columns;
  const pixels = Buffer.alloc(width * cell * 4);
  const bandHeight = image.height / 2;
  const groundRow = Math.round(groundFraction * cell);
  const widths = [];
  const heights = [];

  for (let column = 0; column < columns; column++) {
    const [left, right] = runs[column];
    const [top, bottom] = rowExtent(image, left, right, band * bandHeight, (band + 1) * bandHeight);
    const artHeight = bottom - top + 1;
    const destTop = groundRow - artHeight;
    if (destTop < 0) throw new Error(`セル(${column}, ${band})が収まらない`);

    const artWidth = right - left + 1;
    if (artWidth > cell) throw new Error(`列 ${column} がセル幅を超える`);
    const destLeft = column * cell + Math.round((cell - artWidth) / 2);
    widths.push(artWidth);
    heights.push(artHeight);

    for (let y = 0; y < artHeight; y++) {
      for (let x = 0; x < artWidth; x++) {
        const from = ((top + y) * image.width + left + x) * 4;
        // **セルの中で上下を入れ替えて書く。** レンダラーはアトラスを flipY: false で
        // 取り込み、スクリーン空間スプライトのクアッドは画像の上端を下端へ割り当てる
        // （render/geometry の cell UV と screenSpace の ortho の組み合わせ）。
        // 素直に置くと車が逆さまに描かれる。反転するのはセルの中だけで、
        // 行の並びはそのまま保つ
        const destRow = cell - 1 - destTop - y;
        const to = (destRow * width + destLeft + x) * 4;
        image.pixels.copy(pixels, to, from, from + 4);
      }
    }
  }

  return { pixels, width, widths, heights };
}

// ── 色の道具 ───────────────────────────────────────────────────────────────

/** RGB555 の格子（各チャンネル 8 の倍数）へ丸める。248 で頭打ちにする */
function snapChannel(value) {
  return Math.min(248, Math.round(value / 8) * 8);
}

function snap555([r, g, b]) {
  return [snapChannel(r), snapChannel(g), snapChannel(b)];
}

function rgbToHsl(r, g, b) {
  const rr = r / 255;
  const gg = g / 255;
  const bb = b / 255;
  const max = Math.max(rr, gg, bb);
  const min = Math.min(rr, gg, bb);
  const l = (max + min) / 2;
  const d = max - min;
  if (d < 1e-9) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rr) h = (gg - bb) / d + (gg < bb ? 6 : 0);
  else if (max === gg) h = (bb - rr) / d + 2;
  else h = (rr - gg) / d + 4;
  return [h * 60, s, l];
}

function hslToRgb(h, s, l) {
  if (s < 1e-9) return [l * 255, l * 255, l * 255];
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1 ? [c, x, 0]
    : hp < 2 ? [x, c, 0]
    : hp < 3 ? [0, c, x]
    : hp < 4 ? [0, x, c]
    : hp < 5 ? [x, 0, c]
    : [c, 0, x];
  const m = l - c / 2;
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** `'#rrggbb'` の色相 [deg] */
function hueOf(hex) {
  return rgbToHsl(
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  )[0];
}

/**
 * メディアンカット。`counts` は「色 → 画素数」で、`limit` 色の代表色を返す。
 *
 * 分割する箱は**画素数 × いちばん広いチャンネルの広がり**が最大のものを選び、
 * そのチャンネルの加重中央値で切る。同点は色の値で決めるので、
 * `Map` の反復順に依らず結果が決まる（二度焼きのバイト一致に要る）。
 */
function medianCut(counts, limit) {
  const entries = [...counts.entries()]
    .map(([color, n]) => ({ color, rgb: [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff], n }))
    .sort((left, right) => left.color - right.color);
  if (entries.length === 0) return [];

  const spread = (box) => {
    let widest = 0;
    let channel = 0;
    for (let c = 0; c < 3; c++) {
      let min = 255;
      let max = 0;
      for (const entry of box) {
        if (entry.rgb[c] < min) min = entry.rgb[c];
        if (entry.rgb[c] > max) max = entry.rgb[c];
      }
      if (max - min > widest) {
        widest = max - min;
        channel = c;
      }
    }
    return { widest, channel };
  };

  let boxes = [entries];
  while (boxes.length < limit) {
    let best = -1;
    let bestScore = 0;
    for (let index = 0; index < boxes.length; index++) {
      const box = boxes[index];
      if (box.length < 2) continue;
      const { widest } = spread(box);
      const weight = box.reduce((sum, entry) => sum + entry.n, 0);
      const score = weight * widest;
      if (score > bestScore) {
        bestScore = score;
        best = index;
      }
    }
    if (best < 0) break;

    const box = boxes[best];
    const { channel } = spread(box);
    const sorted = [...box].sort(
      (left, right) => left.rgb[channel] - right.rgb[channel] || left.color - right.color,
    );
    const total = sorted.reduce((sum, entry) => sum + entry.n, 0);
    let accumulated = 0;
    let cut = 0;
    for (; cut < sorted.length - 1; cut++) {
      accumulated += sorted[cut].n;
      if (accumulated * 2 >= total) break;
    }
    boxes.splice(best, 1, sorted.slice(0, cut + 1), sorted.slice(cut + 1));
  }

  return boxes.map((box) => {
    const weight = box.reduce((sum, entry) => sum + entry.n, 0);
    const mean = [0, 1, 2].map(
      (c) => box.reduce((sum, entry) => sum + entry.rgb[c] * entry.n, 0) / weight,
    );
    return snap555(mean);
  });
}

function nearest(palette, rgb) {
  let best = 0;
  let bestDistance = Infinity;
  for (let index = 0; index < palette.length; index++) {
    const [r, g, b] = palette[index];
    const distance = (r - rgb[0]) ** 2 + (g - rgb[1]) ** 2 + (b - rgb[2]) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

/**
 * 塗装（`body`）と共有（`shared`）の 2 群へ分けて量子化し、
 * 8 台ぶんのパレットとインデックス地図を作る。
 *
 * インデックス地図は **1 つだけ**で、8 行がこれを共有する。
 * `-1` は透明（実機のパレット 0 に相当）。
 */
function palettize(playerBand, rivalBand, layout) {
  const width = playerBand.width;
  const height = layout.cell;
  const map = new Int16Array(width * height).fill(-1);
  const bodyCounts = new Map();
  const sharedCounts = new Map();
  const isShared = new Uint8Array(width * height);

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    if (rivalBand.pixels[offset + 3] < OPAQUE) continue;
    const rgb = [rivalBand.pixels[offset], rivalBand.pixels[offset + 1], rivalBand.pixels[offset + 2]];
    const key = (rgb[0] << 16) | (rgb[1] << 8) | rgb[2];
    const difference =
      playerBand.pixels[offset + 3] < OPAQUE
        ? 255 * 3
        : Math.abs(playerBand.pixels[offset] - rgb[0]) +
          Math.abs(playerBand.pixels[offset + 1] - rgb[1]) +
          Math.abs(playerBand.pixels[offset + 2] - rgb[2]);
    const counts = difference <= SHARED_DIFF ? sharedCounts : bodyCounts;
    isShared[index] = difference <= SHARED_DIFF ? 1 : 0;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  const body = medianCut(bodyCounts, PALETTE.body);
  const shared = medianCut(sharedCounts, PALETTE.shared);

  for (let index = 0; index < width * height; index++) {
    const offset = index * 4;
    if (rivalBand.pixels[offset + 3] < OPAQUE) continue;
    const rgb = [rivalBand.pixels[offset], rivalBand.pixels[offset + 1], rivalBand.pixels[offset + 2]];
    map[index] = isShared[index] ? body.length + nearest(shared, rgb) : nearest(body, rgb);
  }

  // 塗装色は**明度と彩度をそのままに色相だけを移す**。共有色は 8 パレットで同一
  const palettes = ENTRANT_COLORS.map((hex) => {
    const hue = hueOf(hex);
    const recoloured = body.map(([r, g, b]) => {
      const [, s, l] = rgbToHsl(r, g, b);
      return snap555(hslToRgb(hue, s, l));
    });
    return [...recoloured, ...shared];
  });

  // 1 つのパレットの中で 2 色が同じ値になると「絵は 1 つ・パレットだけ違う」が
  // 画像から読み取れなくなる（行ごとに固有色数が変わる）。起きたら止める
  for (const [entrant, palette] of palettes.entries()) {
    const seen = new Set();
    for (const [r, g, b] of palette) {
      const key = (r << 16) | (g << 8) | b;
      if (seen.has(key)) {
        throw new Error(`エントラント ${entrant} のパレットで色が衝突した（${key.toString(16)}）`);
      }
      seen.add(key);
    }
  }

  return { map, palettes, body, shared };
}

// ── 焼く ──────────────────────────────────────────────────────────────────

for (const source of CAR_SPRITE_SOURCES) {
  const layout = CAR_SPRITE_GEOMETRY[source.generation];
  if (!layout) throw new Error(`${source.generation} にアトラスの形が無い`);
  const { columns, rows, cell } = layout;

  const image = decodePng(readFileSync(join(repoRoot, 'public', source.from)));
  const runs = columnRuns(image);
  if (runs.length !== columns) {
    throw new Error(`${source.from}: 列が ${runs.length} 本しか見つからない（${columns} 本のはず）`);
  }

  const bands = [0, 1].map((band) => reshapeBand(image, runs, layout, band));
  const width = cell * columns;
  const height = cell * rows;
  const pixels = Buffer.alloc(width * height * 4);
  let note;

  if (!layout.perEntrant) {
    // 第1世代は整形するだけ。自機（黄）とライバル（赤）の 2 行
    for (let row = 0; row < rows; row++) {
      bands[row].pixels.copy(pixels, row * cell * width * 4);
    }
    note = '2 行（自機・ライバル）';
  } else {
    const { map, palettes, body, shared } = palettize(bands[0], bands[1], layout);
    for (let row = 0; row < rows; row++) {
      const palette = palettes[row];
      for (let index = 0; index < width * cell; index++) {
        const entry = map[index];
        if (entry < 0) continue;
        const [r, g, b] = palette[entry];
        const to = (row * cell * width + index) * 4;
        pixels[to] = r;
        pixels[to + 1] = g;
        pixels[to + 2] = b;
        pixels[to + 3] = 255;
      }
    }
    const total = new Set();
    for (const palette of palettes) for (const [r, g, b] of palette) total.add((r << 16) | (g << 8) | b);
    note = `${rows} 行 / パレット ${body.length}+${shared.length} 色 / 固有色 ${total.size}`;
  }

  const relativePath = `public/${source.to}`;
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const png = encodePng(width, height, pixels);
  writeFileSync(absolute, png);

  const heights = bands.flatMap((band) => band.heights);
  console.log(
    `${source.to} ${width}×${height} / 絵の高さ ${Math.min(...heights)}–${Math.max(...heights)} px` +
      ` / 正面の幅 ${bands[0].widths[1]} px / ${note} / ${(png.length / 1024).toFixed(0)} KB`,
  );
}

console.log('車スプライト整形 完了');
