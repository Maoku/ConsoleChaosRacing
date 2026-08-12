#!/usr/bin/env tsx
/**
 * 車スプライトのアトラス整形（実装計画 §3.2 / §2.6）。
 *
 *   npm run build:sprites
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
 * 元の `cars.png` は残す（`data/` と同じく入力は書き換えない）。
 * 二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CAR_SPRITE_GEOMETRY, CAR_SPRITE_SOURCES } from '../src/game/view/shared/car-sprite.ts';
import { decodePng, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 不透明とみなす alpha の下限 */
const OPAQUE = 8;

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

/** 行帯 `[top, bottom)` のなかで絵のある行の範囲 */
function rowExtent(image, top, bottom) {
  let first = -1;
  let last = -1;
  for (let y = top; y < bottom; y++) {
    let used = false;
    for (let x = 0; x < image.width && !used; x++) {
      used = image.pixels[(y * image.width + x) * 4 + 3] >= OPAQUE;
    }
    if (used) {
      if (first < 0) first = y;
      last = y;
    }
  }
  return [first, last];
}

const { columns, rows, cell, groundFraction } = CAR_SPRITE_GEOMETRY;

for (const source of CAR_SPRITE_SOURCES) {
  const image = decodePng(readFileSync(join(repoRoot, 'public', source.from)));
  const runs = columnRuns(image);
  if (runs.length !== columns) {
    throw new Error(`${source.from}: 列が ${runs.length} 本しか見つからない（${columns} 本のはず）`);
  }

  const width = cell * columns;
  const height = cell * rows;
  const pixels = Buffer.alloc(width * height * 4);
  const bandHeight = image.height / rows;
  const metrics = [];

  for (let row = 0; row < rows; row++) {
    const [top, bottom] = rowExtent(image, row * bandHeight, (row + 1) * bandHeight);
    const artHeight = bottom - top + 1;
    // 接地線（絵の下端）をセルの決まった位置へ揃える
    const groundRow = Math.round(groundFraction * cell);
    const destTop = groundRow - artHeight;
    if (destTop < 0) throw new Error(`${source.from}: 行 ${row} の絵がセルに収まらない`);
    metrics.push({ artHeight, widths: [] });

    for (let column = 0; column < columns; column++) {
      const [left, right] = runs[column];
      const artWidth = right - left + 1;
      if (artWidth > cell) throw new Error(`${source.from}: 列 ${column} がセル幅を超える`);
      const destLeft = column * cell + Math.round((cell - artWidth) / 2);
      metrics[row].widths.push(artWidth);

      for (let y = 0; y < artHeight; y++) {
        for (let x = 0; x < artWidth; x++) {
          const from = ((top + y) * image.width + left + x) * 4;
          const to = ((row * cell + destTop + y) * width + destLeft + x) * 4;
          image.pixels.copy(pixels, to, from, from + 4);
        }
      }
    }
  }

  const relativePath = `public/${source.to}`;
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  const png = encodePng(width, height, pixels);
  writeFileSync(absolute, png);

  console.log(
    `${source.to} ${width}×${height} / 絵の高さ ${metrics.map((m) => m.artHeight).join('・')} px` +
      ` / 正面の幅 ${metrics[0].widths[1]} px / ${(png.length / 1024).toFixed(0)} KB`,
  );
}

console.log('車スプライト整形 完了');
