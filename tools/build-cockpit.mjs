#!/usr/bin/env tsx
/**
 * 第4世代の内装とステアリング（実装計画 §2.6 / 8-5）。
 *
 *   npm run build:cockpit
 *
 * 出力は 2 枚。
 *
 * - `assets/gen4/hud/cockpit.png` — ダッシュボード・A ピラー・ルーフ。窓は透明。
 *   画面と同じ縦横比（640×448）で、スクリーン空間スプライト 1 枚として全面へ貼る
 * - `assets/gen4/hud/wheel.png` — ステアリング（256²）。**別ファイルなのは回す軸のため**で、
 *   回転はスプライトの中心まわりに掛かるから、内装へ描き込むと画面中央を軸に回ってしまう
 *
 * **半端な α を 1 画素も作らない。** 窓は `alphaCutoff` で抜くので、
 * 中間の α があると縁が世代やしきい値で変わる（フォントとロゴと同じ規約）。
 * そのぶん縁はギザつくが、640×448 では気にならない。
 *
 * 上下反転はしない — 内装もステアリングも**上下対称ではない**が、
 * レンダラーはアトラスを `flipY: false` で取り込み、スクリーン空間スプライトの
 * クアッドは画像の上端をスプライトの下端へ割り当てる。したがって
 * 「画面で見えるとおりの絵」を描いてから最後に 1 度だけ反転する。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { COCKPIT_ATLAS, WHEEL_ATLAS } from '../src/game/view/shared/cockpit.ts';
import { Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 内装の色。艶消しの暗い樹脂と、ステッチの入った上面 */
const COLORS = {
  dash: [26, 30, 38],
  dashTop: [44, 50, 62],
  pillar: [20, 24, 32],
  roof: [16, 19, 26],
  trim: [96, 108, 126],
  rim: [30, 34, 44],
  rimHighlight: [86, 96, 112],
  spoke: [40, 46, 58],
  hub: [70, 80, 96],
};

/** 内装の寸法（画面に対する割合） */
const INTERIOR = {
  /** ダッシュボードの上端 */
  dashTop: 0.72,
  /** ダッシュボードが中央で下がる量（湾曲） */
  dashCurve: 0.05,
  /** ルーフの下端 */
  roofBottom: 0.1,
  /** A ピラーの根元の幅（画面幅に対する割合） */
  pillarBottom: 0.16,
  /** A ピラーの上端の幅 */
  pillarTop: 0.07,
  /** 明るいトリムの厚み [px] */
  trim: 3,
};

/** 内装 1 枚。画面で見えるとおりの向きで描く */
function drawInterior(width, height) {
  const raster = new Raster(width, height);
  const fill = (x, y, color) => raster.blend(x, y, color, 1);

  for (let x = 0; x < width; x++) {
    const u = x / (width - 1);
    // ── ダッシュボード。中央がいちばん低く、左右で持ち上がる（湾曲した上面）
    const curve = INTERIOR.dashCurve * (1 - Math.cos(u * Math.PI * 2)) * 0.5;
    const dashTop = Math.round((INTERIOR.dashTop + curve) * height);
    for (let y = dashTop; y < height; y++) {
      const depth = (y - dashTop) / Math.max(1, height - dashTop);
      fill(x, y, depth < 0.12 ? COLORS.dashTop : COLORS.dash);
    }
    for (let t = 0; t < INTERIOR.trim; t++) fill(x, dashTop + t, COLORS.trim);

    // ── ルーフ。上端から一定の高さで、中央がわずかに下がる
    const roofBottom = Math.round((INTERIOR.roofBottom - curve * 0.3) * height);
    for (let y = 0; y < roofBottom; y++) fill(x, y, COLORS.roof);
    for (let t = 0; t < INTERIOR.trim; t++) fill(x, roofBottom - 1 - t, COLORS.trim);
  }

  // ── A ピラー。左右対称に、根元から上へ細くなる台形
  for (let y = 0; y < height; y++) {
    const v = Math.min(1, Math.max(0, y / (INTERIOR.dashTop * height)));
    const halfWidth = (INTERIOR.pillarTop + (INTERIOR.pillarBottom - INTERIOR.pillarTop) * v) * width;
    for (let x = 0; x < Math.round(halfWidth); x++) {
      fill(x, y, COLORS.pillar);
      fill(width - 1 - x, y, COLORS.pillar);
    }
    const edge = Math.round(halfWidth);
    for (let t = 0; t < INTERIOR.trim; t++) {
      fill(edge + t, y, COLORS.trim);
      fill(width - 1 - edge - t, y, COLORS.trim);
    }
  }

  return raster;
}

/** ステアリング 1 枚。中心が回転軸になる */
function drawWheel(size) {
  const raster = new Raster(size, size);
  const center = size / 2;
  const outer = center - 2;
  const inner = outer * 0.78;
  const hubRadius = outer * 0.2;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x + 0.5 - center;
      const dy = y + 0.5 - center;
      const distance = Math.hypot(dx, dy);

      // リム。上側を少し明るくして、丸みを 2 色で出す（半端な α は使わない）
      if (distance <= outer && distance >= inner) {
        raster.blend(x, y, dy < -inner * 0.25 ? COLORS.rimHighlight : COLORS.rim, 1);
        continue;
      }
      if (distance < hubRadius) {
        raster.blend(x, y, COLORS.hub, 1);
        continue;
      }
      if (distance >= inner) continue;

      // スポーク 3 本（左右の水平と、下の 1 本）
      const horizontal = Math.abs(dy) <= outer * 0.07;
      const down = dy > 0 && Math.abs(dx) <= outer * 0.07;
      if (horizontal || down) raster.blend(x, y, COLORS.spoke, 1);
    }
  }

  return raster;
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  console.log(`  ${relativePath}  ${buffer.length} B`);
}

const interior = drawInterior(COCKPIT_ATLAS.width, COCKPIT_ATLAS.height);
write(`public/${COCKPIT_ATLAS.url}`, interior.flipVertical().toPng());

const wheel = drawWheel(WHEEL_ATLAS.size);
write(`public/${WHEEL_ATLAS.url}`, wheel.flipVertical().toPng());

console.log('内装生成 完了');
