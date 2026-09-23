#!/usr/bin/env tsx
/**
 * 車のベーステクスチャ → **グレースケールの塗装テクスチャ**（実装計画 §3.4）。
 *
 *   npm run build:paint
 *
 * 元の base color は赤いリバリーが焼き込まれているので、`MeshCommand.color` の乗算では
 * 色が分かれない（黄を掛けても青が落ちて赤が残るだけ）。塗装を無彩色にしておけば、
 * 乗算がそのまま車体色になり、**色は実行時のパラメータ 1 つで決まる**。
 *
 * シェーダの合成は `texture(uBaseColor, uv) * uBaseColorFactor` の素直な乗算で、
 * 部位ごとにマスクを掛ける口は無い（`topColorTexture` は法線が上向きかで切り替わる
 * 地形用の仕組み）。したがって窓も車体色に染まる。元が暗いので
 * 「影のかかった窓」として読める範囲に収まっており、
 * （タイヤは 12-7 で別メッシュへ切り出したので、白のまま描ける）
 * 8 枚を焼き分けるより得だと判断した。
 *
 * 明度の作り方が肝になる。
 * - 塗装部（彩度あり）は **V（HSV の明度）** を使い、平均が `PAINT_TARGET` になるよう
 *   正規化する。輝度をそのまま使うと赤の輝度が低いため、色を掛けたとき暗く沈む
 * - 無彩色部（タイヤ・窓・カーボン）は輝度をそのまま使う
 * - 境目は彩度でなだらかに混ぜ、縁のギザつきを抑える
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { CAR_PAINT } from '../src/game/view/shared/car-model.ts';
import { decodePng, downscaleBox, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * この彩度を下回る画素は「無彩色のディテール」とみなし、輝度をそのまま使う。
 * タイヤ・窓・カーボン・影がここに入る。
 */
const NEUTRAL_SATURATION = 0.22;
/** 無彩色との境目をなだらかにする幅。ここが硬いと縁がギザギザになる */
const NEUTRAL_FEATHER = 0.14;
/**
 * 塗装部の平均をこの明るさへ正規化する。
 * 1.0 に近づけるほど鮮やかになるが、白飛びして陰影が消える。
 *
 * **素の塗装が明るい素材では 0.82 は高すぎる。** 現行の車（黄のリバリー）は
 * 塗装部の V の平均が 0.72 / 0.66 あり、0.82 へ引き上げると塗装面の 6 割が
 * 255 へ張り付いて曲面の陰影が消えた。0.70 なら白飛びは 0 % / 6 % に収まり、
 * 明るさ（上位 25 %）は 190 / 219 で以前（赤・203 / 255）と同等になる。
 * **アルゴリズムは変えていない。動かしたのはこの目標値 1 つだけである。**
 */
const PAINT_TARGET = 0.7;

function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta + 6) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** 塗装部（彩度のある画素）の平均明度。正規化倍率の基準にする */
function meanPaintValue(image) {
  let total = 0;
  let count = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const { s, v } = rgbToHsv(
      image.pixels[index] / 255,
      image.pixels[index + 1] / 255,
      image.pixels[index + 2] / 255,
    );
    if (s >= NEUTRAL_SATURATION) {
      total += v;
      count += 1;
    }
  }
  return count === 0 ? 1 : total / count;
}

function toGrayscale(image) {
  const scale = PAINT_TARGET / meanPaintValue(image);
  const pixels = Buffer.alloc(image.pixels.length);

  for (let index = 0; index < image.pixels.length; index += 4) {
    const r = image.pixels[index] / 255;
    const g = image.pixels[index + 1] / 255;
    const b = image.pixels[index + 2] / 255;
    const { s, v } = rgbToHsv(r, g, b);

    const paintWeight = Math.min(1, Math.max(0, (s - NEUTRAL_SATURATION) / NEUTRAL_FEATHER));
    const level =
      luminance(r, g, b) * (1 - paintWeight) + Math.min(1, v * scale) * paintWeight;
    const quantized = Math.round(level * 255);

    pixels[index] = quantized;
    pixels[index + 1] = quantized;
    pixels[index + 2] = quantized;
    pixels[index + 3] = image.pixels[index + 3];
  }
  return { image: { width: image.width, height: image.height, pixels }, scale };
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  return buffer.length;
}

for (const generation of GENERATION_IDS) {
  const paint = CAR_PAINT[generation];
  if (!paint) continue;

  const source = decodePng(readFileSync(join(repoRoot, 'public', paint.source)));
  if (source.width % paint.size !== 0) {
    throw new Error(`${source.width} を ${paint.size} へ整数倍で縮小できない`);
  }
  const base =
    source.width === paint.size ? source : downscaleBox(source, source.width / paint.size);

  const { image, scale } = toGrayscale(base);
  const bytes = write(`public/${paint.texture}`, encodePng(image.width, image.height, image.pixels));

  console.log(
    `[${generation}] ${paint.source} ${source.width}² → ${image.width}² ` +
      `/ 正規化倍率 ${scale.toFixed(3)} / ${(bytes / 1024).toFixed(0)} KB`,
  );
  console.log(`  → ${paint.texture}`);
}

console.log('塗装テクスチャ生成 完了');
