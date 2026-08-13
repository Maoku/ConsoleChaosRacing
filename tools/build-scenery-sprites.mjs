#!/usr/bin/env tsx
/**
 * 擬似3D世代の背景オブジェクトのスプライト（実装計画 §2.6 / 8-6）。
 *
 *   npm run build:scenery
 *
 * 3 セル（看板・木・タイヤフェンス）を 128² で焼く。**セルいっぱいに描く**ので、
 * `SCENERY_ART` の寸法がそのままスプライトの寸法になる（車のセルと違って
 * 透明な余りを持たない ＝ 引き伸ばしても縮まない。§1.3 のアトラスの性質）。
 *
 * **セルの中で上下を反転して焼く。** レンダラーはアトラスを `flipY: false` で取り込み、
 * スクリーン空間スプライトのクアッドは画像の上端をスプライトの下端へ割り当てるため
 * （車スプライト・フォントと同じ規約）。セルの並びは保つ。
 *
 * 色は世代ごとに変える。**FC は 54 色マスターパレットの値そのもの**を置く —
 * 外れた色は最近傍で隣へ落ち、塗り分けがそのまま消えるため（§3.2）。
 * SFC は RGB555 の格子（各チャンネル 8 の倍数）。半透明は 1 画素も作らない。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import {
  SCENERY_BILLBOARDS,
  SCENERY_SPRITES,
  SCENERY_SPRITE_GEOMETRY,
} from '../src/game/view/shared/scenery-sprite.ts';
import { Raster, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { columns, rows, cells } = SCENERY_SPRITE_GEOMETRY;

/**
 * 世代ごとの色。
 *
 * FC は 54 色マスターパレットの値（`MASTER_PALETTE_RGB` にあるものだけ）、
 * SFC は RGB555 の格子。どちらも階調は最小限に抑える（FC は同時 25 色の予算がある）。
 */
const PALETTES = {
  FC: {
    signFace: [236, 238, 236],
    signInk: [152, 34, 32],
    signPost: [84, 90, 0],
    trunk: [60, 24, 0],
    leafLight: [40, 114, 0],
    leafDark: [8, 58, 0],
    tyre: [84, 84, 84],
    tyreDark: [0, 0, 0],
    tyreBand: [236, 238, 236],
  },
  SFC: {
    signFace: [240, 240, 232],
    signInk: [192, 40, 40],
    signPost: [120, 120, 112],
    trunk: [88, 56, 32],
    leafLight: [72, 152, 64],
    leafDark: [24, 88, 32],
    tyre: [64, 64, 72],
    tyreDark: [24, 24, 32],
    tyreBand: [240, 240, 240],
  },
  // 3D の 2 世代は truecolor。色数の制約が無いので階調を少しだけ増やす
  PS1: {
    signFace: [236, 236, 228],
    signInk: [186, 46, 40],
    signPost: [116, 118, 112],
    trunk: [82, 54, 34],
    leafLight: [86, 148, 66],
    leafDark: [34, 84, 40],
    tyre: [58, 58, 64],
    tyreDark: [22, 22, 28],
    tyreBand: [236, 236, 236],
  },
  PS2: {
    signFace: [242, 242, 236],
    signInk: [198, 52, 44],
    signPost: [126, 130, 126],
    trunk: [94, 62, 38],
    leafLight: [98, 162, 76],
    leafDark: [38, 92, 46],
    tyre: [62, 62, 70],
    tyreDark: [24, 24, 30],
    tyreBand: [242, 242, 242],
  },
};

/** 看板 — 支柱の上に矩形の板。板の中に警告の帯を 1 本 */
function drawSign(palette, cell) {
  const raster = new Raster(cell, cell);
  const postWidth = Math.round(cell * 0.1);
  const boardBottom = Math.round(cell * 0.62);

  // 支柱（接地線 ＝ セルの下端まで）
  for (let y = boardBottom; y < cell; y++) {
    for (let x = 0; x < postWidth; x++) {
      raster.blend(Math.round((cell - postWidth) / 2) + x, y, palette.signPost, 1);
    }
  }
  // 板
  for (let y = 0; y < boardBottom; y++) {
    for (let x = 0; x < cell; x++) {
      const border = Math.min(x, y, cell - 1 - x, boardBottom - 1 - y);
      raster.blend(x, y, border < cell * 0.06 ? palette.signInk : palette.signFace, 1);
    }
  }
  // 中の帯（「コーナー」の矢印に見える斜めの帯）
  for (let y = Math.round(cell * 0.16); y < Math.round(cell * 0.46); y++) {
    const width = Math.round(cell * 0.16);
    const start = Math.round(cell * 0.2 + (y - cell * 0.16) * 0.9);
    for (let x = start; x < start + width && x < cell; x++) {
      raster.blend(x, y, palette.signInk, 1);
    }
  }
  return raster;
}

/** 木 — 幹と、2 色の葉の塊 */
function drawTree(palette, cell) {
  const raster = new Raster(cell, cell);
  const trunkWidth = Math.round(cell * 0.12);
  const trunkTop = Math.round(cell * 0.62);
  const crownCenterY = Math.round(cell * 0.34);
  const crownRadius = cell * 0.36;

  for (let y = trunkTop; y < cell; y++) {
    for (let x = 0; x < trunkWidth; x++) {
      raster.blend(Math.round((cell - trunkWidth) / 2) + x, y, palette.trunk, 1);
    }
  }
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const dx = x + 0.5 - cell / 2;
      const dy = (y + 0.5 - crownCenterY) * 1.15;
      const distance = Math.hypot(dx, dy);
      if (distance > crownRadius) continue;
      // 左上を明るく。階調は 2 段だけ（FC の色数の予算）
      raster.blend(x, y, dx - dy < crownRadius * 0.2 ? palette.leafLight : palette.leafDark, 1);
    }
  }
  return raster;
}

/** タイヤフェンス — 横に並べた 3 段のタイヤ。白い帯を 1 本入れて縁を読ませる */
function drawTyres(palette, cell) {
  const raster = new Raster(cell, cell);
  const columnsOfTyres = 6;
  const rowsOfTyres = 3;
  const tyreWidth = cell / columnsOfTyres;
  const tyreHeight = cell / rowsOfTyres;

  for (let row = 0; row < rowsOfTyres; row++) {
    for (let column = 0; column < columnsOfTyres; column++) {
      const centerX = (column + 0.5) * tyreWidth;
      const centerY = (row + 0.5) * tyreHeight;
      for (let y = Math.floor(row * tyreHeight); y < Math.ceil((row + 1) * tyreHeight); y++) {
        for (let x = Math.floor(column * tyreWidth); x < Math.ceil((column + 1) * tyreWidth); x++) {
          const dx = (x + 0.5 - centerX) / (tyreWidth / 2);
          const dy = (y + 0.5 - centerY) / (tyreHeight / 2);
          const distance = Math.hypot(dx, dy);
          if (distance > 1) continue;
          // 中央の穴を暗く。上段だけ白い帯を巻く
          const color =
            distance < 0.35
              ? palette.tyreDark
              : row === 0 && column % 2 === 0
                ? palette.tyreBand
                : palette.tyre;
          raster.blend(x, y, color, 1);
        }
      }
    }
  }
  return raster;
}

/** セルのラスタをアトラスへ貼る。**セルの中だけを上下反転する** */
function blitFlipped(atlas, source, column, cell) {
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const from = ((cell - 1 - y) * cell + x) * 4;
      const to = (y * atlas.width + column * cell + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        atlas.pixels[to + channel] = source.pixels[from + channel];
      }
    }
  }
}

for (const generation of GENERATION_IDS) {
  // 擬似3D 世代はスクリーン空間スプライト、3D 世代はワールド空間のビルボード。
  // 使い方は違うが**焼く絵は同じ 1 つの生成器**から出る（8-6）
  const layout = SCENERY_SPRITES[generation] ?? SCENERY_BILLBOARDS[generation];
  if (!layout) continue;
  const palette = PALETTES[generation];
  if (!palette) throw new Error(`${generation} の色が定義されていない`);

  const cell = layout.cellSize;
  const atlas = new Raster(cell * columns, cell * rows);
  blitFlipped(atlas, drawSign(palette, cell), cells.sign, cell);
  blitFlipped(atlas, drawTree(palette, cell), cells.tree, cell);
  blitFlipped(atlas, drawTyres(palette, cell), cells.tyres, cell);

  const png = encodePng(atlas.width, atlas.height, atlas.pixels);
  const relativePath = `public/${layout.url}`;
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, png);

  const colors = new Set();
  for (let offset = 0; offset < atlas.pixels.length; offset += 4) {
    if (atlas.pixels[offset + 3] === 0) continue;
    colors.add(
      `${atlas.pixels[offset]},${atlas.pixels[offset + 1]},${atlas.pixels[offset + 2]}`,
    );
  }
  console.log(
    `${generation}: ${layout.url} ${atlas.width}×${atlas.height} / ` +
      `${colors.size} 色 / 出す種類 ${layout.kinds.join('・')} / ${(png.length / 1024).toFixed(1)} KB`,
  );
}

console.log('背景オブジェクト生成 完了');
