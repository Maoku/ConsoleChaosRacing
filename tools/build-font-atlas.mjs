#!/usr/bin/env tsx
/**
 * HUD フォントアトラス（実装計画 §2.6 / §3.5）。
 *
 *   npm run build:font
 *
 * `OverlayCommand` は WebGL レンダラーで描かれないため、HUD の文字は
 * スクリーン空間スプライトで出すしかない。その字形をここで焼く。
 *
 * 16 列 × 6 行 = 96 セル（ASCII 0x20–0x7F）、1 セル 8²。字形は 5×7 で
 * **セルの左上**へ置き、余りは透明のままにする。字送り 6 px（`FONT_ATLAS.advance`）が
 * セルの一辺より狭いのはそのためで、隣のセルの透明画素は `alphaCutoff` で捨てられる。
 *
 * 色は**白 1 色**で焼く。世代ごとの色は実行時の `SpriteCommand.color` が掛けるので、
 * 4 世代・順位色・影のすべてがこの 1 枚で足りる（ミニマップのマーカーと同じ考え方）。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { FONT_ATLAS } from '../src/game/view/shared/font.ts';
import { GLYPH_HEIGHT, GLYPH_WIDTH, forEachGlyphPixel } from './lib/glyphs.mjs';
import { encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { columns, rows, cell, firstCharCode } = FONT_ATLAS;

if (GLYPH_WIDTH !== FONT_ATLAS.glyphWidth || GLYPH_HEIGHT !== FONT_ATLAS.glyphHeight) {
  throw new Error('字形の寸法が FONT_ATLAS と食い違っている');
}
if (GLYPH_WIDTH > cell || GLYPH_HEIGHT > cell) throw new Error('字形がセルに収まらない');

const width = columns * cell;
const height = rows * cell;
const pixels = Buffer.alloc(width * height * 4);

let inkedCells = 0;

for (let index = 0; index < columns * rows; index++) {
  const column = index % columns;
  const row = Math.floor(index / columns);
  let inked = 0;

  forEachGlyphPixel(firstCharCode + index, (glyphX, glyphY) => {
    // **セルの中で上下を入れ替えて書く。** レンダラーはアトラスを flipY: false で
    // 取り込み、スクリーン空間スプライトのクアッドは画像の上端をスプライトの下端へ
    // 割り当てる。素直に置くと文字が逆さまに描かれる。反転するのはセルの中だけで、
    // セルの並び（＝文字コードの順）はそのまま保つ（`build-car-sprites.mjs` と同じ）
    const x = column * cell + glyphX;
    const y = row * cell + (cell - 1 - glyphY);
    const offset = (y * width + x) * 4;
    pixels[offset] = 255;
    pixels[offset + 1] = 255;
    pixels[offset + 2] = 255;
    pixels[offset + 3] = 255;
    inked += 1;
  });

  if (inked > 0) inkedCells += 1;
}

const relativePath = 'public/assets/common/font.png';
const absolute = join(repoRoot, relativePath);
mkdirSync(dirname(absolute), { recursive: true });
const png = encodePng(width, height, pixels);
writeFileSync(absolute, png);

console.log(
  `${relativePath} ${width}×${height} / ${columns}×${rows} セル / ` +
    `字形 ${GLYPH_WIDTH}×${GLYPH_HEIGHT} / 点灯 ${inkedCells} セル / ${png.length} B`,
);
console.log('HUD フォント生成 完了');
