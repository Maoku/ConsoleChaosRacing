#!/usr/bin/env tsx
/**
 * 遠景を SFC の BG スペックへ寄せる（実装計画 8-2）。
 *
 *   npm run build:backdrop
 *
 * 実機の BG 面は 8×8 タイルで、**タイルあたり 16 色**（4bpp）のパレット割りに従う。
 * 同梱の `coast.png` はタイルあたり最大 32 色を使い、色も RGB555 の格子から
 * 外れている。そのままだと §1.4 の `paletteBlockSize: 8` が意味を持たない。
 *
 * ここでやるのは 2 つだけ。
 *
 * 1. 全画素を **RGB555 の格子**（各チャンネル 8 の倍数）へ丸める
 * 2. タイルごとに、**いちばん使われていない色を最も近い色へ畳んで** 16 色に収める
 *
 * 絵柄そのものは変えない（拡大縮小も、ディザも入れない）。入力の
 * `assets/gen2/backgrounds/coast.png` は**書き換えない**。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { BACKDROPS } from '../src/game/view/shared/backdrop.ts';
import { decodePng, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** RGB555 の格子（各チャンネル 8 の倍数）へ丸める。248 で頭打ちにする */
function snapChannel(value) {
  return Math.min(248, Math.round(value / 8) * 8);
}

function key(pixels, offset) {
  return (pixels[offset] << 16) | (pixels[offset + 1] << 8) | pixels[offset + 2];
}

function distance(a, b) {
  const dr = ((a >> 16) & 0xff) - ((b >> 16) & 0xff);
  const dg = ((a >> 8) & 0xff) - ((b >> 8) & 0xff);
  const db = (a & 0xff) - (b & 0xff);
  return dr * dr + dg * dg + db * db;
}

/**
 * 1 タイルを `limit` 色以内へ落とす。
 *
 * 使用画素数の少ない色から順に、**残す色のうち最も近いもの**へ畳む。
 * 同数のときは色の値で決めるので、実行順に依らず結果が決まる（決定論）。
 */
function reduceTile(counts, limit) {
  const entries = [...counts.entries()].sort((left, right) => {
    return right[1] - left[1] || left[0] - right[0];
  });
  const keep = entries.slice(0, limit).map(([color]) => color);
  const mapping = new Map();
  for (const [color] of entries) {
    if (keep.includes(color)) {
      mapping.set(color, color);
      continue;
    }
    let best = keep[0];
    let bestDistance = Infinity;
    for (const candidate of keep) {
      const d = distance(color, candidate);
      if (d < bestDistance || (d === bestDistance && candidate < best)) {
        best = candidate;
        bestDistance = d;
      }
    }
    mapping.set(color, best);
  }
  return mapping;
}

function convert(layout) {
  const image = decodePng(readFileSync(join(repoRoot, 'public', layout.source)));
  if (image.width !== layout.width || image.height !== layout.height) {
    throw new Error(`${layout.source} の寸法が表と食い違う`);
  }
  const { size, maxColorsPerTile } = layout.tileGrid;
  const pixels = Buffer.from(image.pixels);

  // ① RGB555 の格子へ
  for (let offset = 0; offset < pixels.length; offset += 4) {
    pixels[offset] = snapChannel(pixels[offset]);
    pixels[offset + 1] = snapChannel(pixels[offset + 1]);
    pixels[offset + 2] = snapChannel(pixels[offset + 2]);
  }

  // ② タイルごとに 16 色以内へ
  let reducedTiles = 0;
  let before = 0;
  for (let tileY = 0; tileY < image.height / size; tileY++) {
    for (let tileX = 0; tileX < image.width / size; tileX++) {
      const counts = new Map();
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = ((tileY * size + y) * image.width + tileX * size + x) * 4;
          const color = key(pixels, offset);
          counts.set(color, (counts.get(color) ?? 0) + 1);
        }
      }
      before = Math.max(before, counts.size);
      if (counts.size <= maxColorsPerTile) continue;
      reducedTiles += 1;

      const mapping = reduceTile(counts, maxColorsPerTile);
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = ((tileY * size + y) * image.width + tileX * size + x) * 4;
          const color = mapping.get(key(pixels, offset));
          pixels[offset] = (color >> 16) & 0xff;
          pixels[offset + 1] = (color >> 8) & 0xff;
          pixels[offset + 2] = color & 0xff;
        }
      }
    }
  }

  return { pixels, reducedTiles, before };
}

/** 実測（`Docs/QUALITY_REVIEW.md` へ記録する値） */
function measure(pixels, width, height, size) {
  const tiles = new Set();
  const colors = new Set();
  let maxPerTile = 0;
  for (let tileY = 0; tileY < height / size; tileY++) {
    for (let tileX = 0; tileX < width / size; tileX++) {
      const local = new Set();
      const bytes = [];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = ((tileY * size + y) * width + tileX * size + x) * 4;
          const color = key(pixels, offset);
          local.add(color);
          colors.add(color);
          bytes.push(color);
        }
      }
      tiles.add(bytes.join(','));
      maxPerTile = Math.max(maxPerTile, local.size);
    }
  }
  return { uniqueTiles: tiles.size, colors: colors.size, maxPerTile };
}

for (const generation of GENERATION_IDS) {
  const layout = BACKDROPS[generation];
  if (!layout?.tileGrid) continue;

  const { pixels, reducedTiles, before } = convert(layout);
  const after = measure(pixels, layout.width, layout.height, layout.tileGrid.size);
  const png = encodePng(layout.width, layout.height, pixels);

  const relativePath = `public/${layout.texture}`;
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, png);

  console.log(`${generation}: ${layout.source} → ${layout.texture}`);
  console.log(
    `  タイルあたりの色数 ${before} → ${after.maxPerTile}（上限 ${layout.tileGrid.maxColorsPerTile}）` +
      ` / ${reducedTiles} タイルを畳んだ`,
  );
  console.log(
    `  全体の色数 ${after.colors} / ユニークタイル ${after.uniqueTiles} / ${(png.length / 1024).toFixed(0)} KB`,
  );
}

console.log('遠景生成 完了');
