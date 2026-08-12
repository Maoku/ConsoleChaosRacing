#!/usr/bin/env tsx
/**
 * コース中心線 → 世代別ミニマップ俯瞰図 PNG ＋ 車マーカーアトラス（実装計画 §2.6 / §3.6）。
 *
 * `src/game/sim/track.ts` と `src/game/view/shared/minimap-layout.ts` を**直接 import** する。
 * コース形状も座標変換もツール側に複製しないので、俯瞰図テクスチャと実行時マーカーの
 * 座標系がずれる余地が構造的に無い。
 *
 *   npm run build:minimap
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { TRACK } from '../src/game/sim/track.ts';
import {
  MINIMAP_LAYOUTS,
  minimapPoint,
  minimapProjection,
  textureRect,
} from '../src/game/view/shared/minimap-layout.ts';
import { Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** マーカーは白で描き、実行時に SpriteCommand.color で色を付ける */
const WHITE = [255, 255, 255];

/**
 * 1 世代ぶんの俯瞰図。
 *
 * コースは中心線のポリラインとして描く。56² のミニマップでは 1 画素が約 15 m なので、
 * 路面幅 12 m は 1 画素に満たない。実寸で塗るのではなく、世代ごとに決めた
 * 線幅（`MINIMAP_LAYOUTS`）で引くのが正しい。
 *
 * 色はテクスチャへ焼き込む。輪郭とパネルは 1 枚のスプライトで描くため、
 * 実行時の tint（1 色）では 2 つを別々に色付けできないからである。
 * 色の定義は `minimap-layout.ts` の 1 か所にある。
 */
function drawMinimap(generation) {
  const layout = MINIMAP_LAYOUTS[generation];
  const raster = new Raster(layout.size, layout.size);
  const projection = minimapProjection(TRACK.bounds, textureRect(layout.size), layout.margin);
  const plot = layout.hardEdges ? raster.hardDot.bind(raster) : raster.dot.bind(raster);

  // 背景パネル。**不透明で焼く** — 半透明にするのは実行時の hardwareBlend の役目で、
  // 世代ごとの半透明の作法（color math / 固定係数 / GS alpha）をそのまま使うため
  if (layout.panelColor) {
    for (let y = 0; y < layout.size; y++) {
      for (let x = 0; x < layout.size; x++) {
        const edge = Math.min(x, y, layout.size - 1 - x, layout.size - 1 - y);
        const fade = layout.panelFade > 0 ? Math.min(1, (edge + 0.5) / layout.panelFade) : 1;
        raster.blend(x, y, layout.panelColor, fade);
      }
    }
  }

  // 輪郭の外周を先に薄く敷く（アンチエイリアスが使える世代のみ）
  if (!layout.hardEdges) {
    for (const sample of TRACK.samples) {
      const [x, y] = minimapPoint(projection, sample.position[0], sample.position[2]);
      raster.dot(x, y, layout.lineWidth + 2, layout.lineColor, 0.28);
    }
  }

  // 中心線。1 m 間隔のサンプルをそのまま点として置けば、線幅ぶんで隙間なく繋がる
  for (const sample of TRACK.samples) {
    const [x, y] = minimapPoint(projection, sample.position[0], sample.position[2]);
    plot(x, y, layout.lineWidth, layout.lineColor, 1);
  }

  // スタート/フィニッシュライン。s = 0 の法線方向へ線幅の 3 倍
  const start = TRACK.sampleAt(0);
  const tickLength = Math.max(2, layout.lineWidth * 3);
  for (let step = -tickLength; step <= tickLength; step += 0.5) {
    const worldX = start.position[0] + start.right[0] * (step / projection.scale);
    const worldZ = start.position[2] + start.right[1] * (step / projection.scale);
    const [x, y] = minimapPoint(projection, worldX, worldZ);
    plot(x, y, Math.max(1, layout.lineWidth - 1), layout.lineColor, 1);
  }

  // アトラスは flipY:false で取り込まれるので、画面座標系で描いた図を上下反転して渡す
  return { layout, png: raster.flipVertical().toPng() };
}

/**
 * 車マーカーのアトラス。8×8 の丸と四角を横に 2 セル並べる。
 * サイズはコマンド側で指定するので、この 1 枚で 4 世代・8 台すべてを賄える。
 */
function drawMarkers() {
  const cell = 8;
  const raster = new Raster(cell * 2, cell);

  // セル 0: 丸（他車）
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const distance = Math.hypot(x + 0.5 - cell / 2, y + 0.5 - cell / 2);
      if (distance <= cell / 2 - 0.5) raster.blend(x, y, WHITE, 1);
    }
  }

  // セル 1: 四角（自機）。縁を 1 画素空けて、丸と大きさが揃って見えるようにする
  for (let y = 1; y < cell - 1; y++) {
    for (let x = 1; x < cell - 1; x++) {
      raster.blend(cell + x, y, WHITE, 1);
    }
  }

  return raster.toPng();
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  console.log(`  ${relativePath}  ${buffer.length} B`);
}

console.log(
  `コース: 全長 ${TRACK.length.toFixed(1)} m / ${TRACK.samples.length} サンプル / ` +
    `bounds ${TRACK.bounds.size[0].toFixed(1)} x ${TRACK.bounds.size[1].toFixed(1)} m`,
);

const generationDirectory = { FC: 'gen1', SFC: 'gen2', PS1: 'gen3', PS2: 'gen4' };
for (const generation of GENERATION_IDS) {
  const { layout, png } = drawMinimap(generation);
  write(`public/assets/${generationDirectory[generation]}/hud/minimap.png`, png);
  console.log(`    ${generation}: ${layout.size}² / 線幅 ${layout.lineWidth}px`);
}

write('public/assets/common/markers.png', drawMarkers());
console.log('ミニマップ生成 完了');
