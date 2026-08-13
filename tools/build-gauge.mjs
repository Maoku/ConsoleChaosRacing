#!/usr/bin/env tsx
/**
 * タコメーターの盤・針・中央の丸（実装計画 §2.6 / 8-3）。
 *
 *   npm run build:gauge
 *
 * `src/game/view/shared/tachometer.ts` を**直接 import** する。振れ幅
 * （`TACHO_SWEEP`）とレッドゾーンの位置（`TACHO_REDLINE`）を焼くのも、
 * 実行時に針を回すのも同じ 1 つの定数なので、目盛りと針がずれる余地が無い
 * （ミニマップ・フォントと同じ作り）。
 *
 * 出力は 2 列 × 2 行のアトラス（第3世代 128² / 第4世代 256²）。
 * セルは 0: 盤・1: 針・2: 中央の丸で、4 つ目は空けてある。
 *
 * **各セルは中で上下を反転して焼く。** レンダラーはアトラスを `flipY: false` で
 * 取り込み、スクリーン空間スプライトのクアッドは画像の上端をスプライトの下端へ
 * 割り当てるため（`build-font-atlas.mjs` と同じ理由）。セルの並びは保つ。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import {
  TACHO_ATLAS,
  TACHO_REDLINE,
  TACHO_SWEEP,
  TACHOMETERS,
} from '../src/game/view/shared/tachometer.ts';
import { Raster, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 目盛りの数（0 から最大まで）。主目盛りの間に副目盛りを 1 本ずつ入れる */
const MAJOR_TICKS = 5;

/** 針の長さ（半径に対する割合）と根元の太さ（セルの一辺に対する割合） */
const NEEDLE = { length: 0.8, width: 0.055, tail: 0.12 };

/** 角度 [rad]（真上が 0・時計回りが正）→ 中心からの単位ベクトル（画面座標・Y 下） */
function direction(angle) {
  return [Math.sin(angle), -Math.cos(angle)];
}

/** 盤（目盛りとレッドゾーン）。セル 0 */
function drawDial(size, colors) {
  const raster = new Raster(size, size);
  const center = size / 2;
  const radius = center - 1;

  // 面と縁。縁は 1.5 px ぶんの輪
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      if (distance > radius + 0.5) continue;
      const edge = radius - distance;
      if (edge < 1.5) raster.blend(x, y, colors.rim, Math.min(1, radius + 0.5 - distance));
      else raster.blend(x, y, colors.face, 1);
    }
  }

  // レッドゾーンの弧。針が指す範囲と同じ角度で刻む
  const arcOuter = radius - 2;
  const arcInner = radius - 5.5 * (size / 64);
  const steps = Math.max(64, Math.round(size * 4));
  for (let step = 0; step <= steps; step++) {
    const value = TACHO_REDLINE + (1 - TACHO_REDLINE) * (step / steps);
    const angle = TACHO_SWEEP.start + (TACHO_SWEEP.end - TACHO_SWEEP.start) * value;
    const [dx, dy] = direction(angle);
    for (let r = arcInner; r <= arcOuter; r += 0.5) {
      raster.blend(center + dx * r, center + dy * r, colors.redzone, 1);
    }
  }

  // 目盛り。主目盛りは長く、副目盛りは半分
  const total = MAJOR_TICKS * 2 - 1;
  for (let index = 0; index < total; index++) {
    const value = index / (total - 1);
    const major = index % 2 === 0;
    const angle = TACHO_SWEEP.start + (TACHO_SWEEP.end - TACHO_SWEEP.start) * value;
    const [dx, dy] = direction(angle);
    const outer = radius - 2;
    const inner = outer - (major ? 8 : 4) * (size / 64);
    const width = major ? 1.6 : 0.9;
    for (let r = inner; r <= outer; r += 0.4) {
      raster.dot(center + dx * r, center + dy * r, width, colors.tick, 1);
    }
  }

  return raster;
}

/** 針。セル 1。真上（角度 0）を向いた状態で焼き、実行時に rotation で回す */
function drawNeedle(size, colors) {
  const raster = new Raster(size, size);
  const center = size / 2;
  const length = center * NEEDLE.length;
  const halfWidth = (size * NEEDLE.width) / 2;
  const tail = center * NEEDLE.tail;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      // 真上向き ＝ -Y。先端へ向かって細くなる三角形
      const along = -dy;
      if (along < -tail || along > length) continue;
      const taper = along <= 0 ? 1 : 1 - (along / length) * 0.72;
      const coverage = Math.min(1, Math.max(0, halfWidth * taper + 0.5 - Math.abs(dx)));
      if (coverage > 0) raster.blend(x, y, colors.needle, coverage);
    }
  }

  return raster;
}

/** 中央の丸。セル 2。針の付け根を隠す */
function drawHub(size, colors) {
  const raster = new Raster(size, size);
  const center = size / 2;
  const radius = center * 0.16;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center);
      const coverage = Math.min(1, Math.max(0, radius + 0.5 - distance));
      if (coverage > 0) raster.blend(x, y, colors.hub, coverage);
    }
  }
  return raster;
}

/** セルのラスタをアトラスへ貼る。**セルの中だけを上下反転する** */
function blitFlipped(atlas, cellRaster, column, row, size) {
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const from = ((size - 1 - y) * size + x) * 4;
      const to = ((row * size + y) * atlas.width + column * size + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        atlas.pixels[to + channel] = cellRaster.pixels[from + channel];
      }
    }
  }
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  console.log(`  ${relativePath}  ${buffer.length} B`);
}

for (const generation of GENERATION_IDS) {
  const layout = TACHOMETERS[generation];
  // 第1・第2世代にタコメーターは出さない（アナログのメーターは 3D 世代の作法）
  if (!layout) continue;

  const size = layout.cellSize;
  const atlas = new Raster(size * TACHO_ATLAS.columns, size * TACHO_ATLAS.rows);
  const cells = [
    [TACHO_ATLAS.cells.dial, drawDial(size, layout.colors)],
    [TACHO_ATLAS.cells.needle, drawNeedle(size, layout.colors)],
    [TACHO_ATLAS.cells.hub, drawHub(size, layout.colors)],
  ];
  for (const [cell, raster] of cells) {
    blitFlipped(atlas, raster, cell % TACHO_ATLAS.columns, Math.floor(cell / TACHO_ATLAS.columns), size);
  }

  const png = encodePng(atlas.width, atlas.height, atlas.pixels);
  write(`public/${layout.url}`, png);
  console.log(
    `    ${generation}: ${atlas.width}×${atlas.height} / セル ${size}² / ` +
      `振れ ${((TACHO_SWEEP.end - TACHO_SWEEP.start) * 180) / Math.PI}° / ` +
      `レッドゾーン ${Math.round(TACHO_REDLINE * 100)}%`,
  );
}

console.log('タコメーター生成 完了');
