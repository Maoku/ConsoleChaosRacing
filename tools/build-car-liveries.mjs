#!/usr/bin/env tsx
/**
 * 車のベーステクスチャ → エントラントごとの塗り分け（リバリー）。
 *
 *   npm run build:liveries
 *
 * 元の base color は赤いリバリーが焼き込まれているので、`MeshCommand.color` の
 * 乗算では色が分かれない（黄を掛けても青が落ちて赤が残るだけ）。8 台を見分けるには
 * テクスチャそのものを塗り替えるしかない。
 *
 * **彩度のある画素だけ色相を差し替える。** タイヤ・窓・グリル・影といった無彩色の
 * 画素はそのまま通すので、陰影もディテールも保たれたまま車体色だけが変わる。
 * 実機時代のカラーバリエーションと同じ考え方（パレットの一部だけを差し替える）。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { ENTRANT_COLORS } from '../src/game/view/shared/variants.ts';
import { CAR_LIVERIES, carLiveryTexture } from '../src/game/view/shared/car-model.ts';
import { decodePng, downscaleBox, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * この彩度を下回る画素は「無彩色のディテール」とみなして色相を変えない。
 * タイヤ・窓・カーボン・影がここに入る。
 */
const NEUTRAL_SATURATION = 0.22;
/** 無彩色との境目をなだらかにする幅。ここが硬いと縁がギザギザになる */
const NEUTRAL_FEATHER = 0.14;

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

function hsvToRgb(h, s, v) {
  const sector = (((h % 1) + 1) % 1) * 6;
  const index = Math.floor(sector);
  const fraction = sector - index;
  const p = v * (1 - s);
  const q = v * (1 - s * fraction);
  const t = v * (1 - s * (1 - fraction));
  switch (index % 6) {
    case 0:
      return [v, t, p];
    case 1:
      return [q, v, p];
    case 2:
      return [p, v, t];
    case 3:
      return [p, q, v];
    case 4:
      return [t, p, v];
    default:
      return [v, p, q];
  }
}

function parseColor(hex) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
}

/**
 * 塗り替え対象（彩度のある画素）の平均彩度と平均明度。
 * 目標色へどれだけ寄せるかの倍率をここから決める。
 */
function measureLivery(image) {
  let saturation = 0;
  let value = 0;
  let count = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const { s, v } = rgbToHsv(
      image.pixels[index] / 255,
      image.pixels[index + 1] / 255,
      image.pixels[index + 2] / 255,
    );
    if (s >= NEUTRAL_SATURATION) {
      saturation += s;
      value += v;
      count += 1;
    }
  }
  return count === 0
    ? { saturation: 1, value: 1 }
    : { saturation: saturation / count, value: value / count };
}

/**
 * 1 台ぶんのリバリー。
 *
 * 色相は目標色のものへ丸ごと差し替え、彩度は「元の彩度 × 目標へ寄せる倍率」にする。
 * 明度はそのまま残すので、ハイライトはハイライトのまま色だけが変わる。
 */
function recolor(image, targetHex, source) {
  const [tr, tg, tb] = parseColor(targetHex);
  const target = rgbToHsv(tr, tg, tb);
  // 淡い目標色（藤色など）で純色になってしまわないよう、彩度の倍率で寄せる
  const saturationScale = Math.min(1.6, Math.max(0.35, target.s / source.saturation));
  // 明度も寄せる。これが無いと暗い目標色（茶）が明るい橙と見分けられない
  const valueScale = Math.min(1.25, Math.max(0.5, target.v / source.value));

  const pixels = Buffer.alloc(image.pixels.length);
  for (let index = 0; index < image.pixels.length; index += 4) {
    const r = image.pixels[index] / 255;
    const g = image.pixels[index + 1] / 255;
    const b = image.pixels[index + 2] / 255;
    const { h, s, v } = rgbToHsv(r, g, b);

    // 無彩色との境目をなだらかに混ぜる
    const weight = Math.min(1, Math.max(0, (s - NEUTRAL_SATURATION) / NEUTRAL_FEATHER));
    if (weight <= 0) {
      pixels[index] = image.pixels[index];
      pixels[index + 1] = image.pixels[index + 1];
      pixels[index + 2] = image.pixels[index + 2];
      pixels[index + 3] = image.pixels[index + 3];
      continue;
    }

    const [nr, ng, nb] = hsvToRgb(
      target.h,
      Math.min(1, s * saturationScale),
      Math.min(1, v * valueScale),
    );
    pixels[index] = Math.round((r + (nr - r) * weight) * 255);
    pixels[index + 1] = Math.round((g + (ng - g) * weight) * 255);
    pixels[index + 2] = Math.round((b + (nb - b) * weight) * 255);
    pixels[index + 3] = image.pixels[index + 3];
  }
  return { width: image.width, height: image.height, pixels };
}

function write(relativePath, buffer) {
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, buffer);
  return buffer.length;
}

for (const generation of GENERATION_IDS) {
  const livery = CAR_LIVERIES[generation];
  if (!livery) continue;

  const source = decodePng(readFileSync(join(repoRoot, 'public', livery.source)));
  if (source.width % livery.size !== 0) {
    throw new Error(`${source.width} を ${livery.size} へ整数倍で縮小できない`);
  }
  const base =
    source.width === livery.size ? source : downscaleBox(source, source.width / livery.size);
  const measured = measureLivery(base);

  console.log(
    `[${generation}] ${livery.source} ${source.width}² → ${base.width}² / ` +
      `塗り替え対象の平均 彩度 ${measured.saturation.toFixed(3)} 明度 ${measured.value.toFixed(3)}`,
  );

  let bytes = 0;
  for (let entrant = 0; entrant < livery.count; entrant++) {
    const color = ENTRANT_COLORS[entrant % ENTRANT_COLORS.length];
    const image = recolor(base, color, measured);
    const url = carLiveryTexture(generation, entrant);
    if (!url) throw new Error(`${generation} のリバリー URL が引けない`);
    bytes += write(`public/${url}`, encodePng(image.width, image.height, image.pixels));
    console.log(`  #${entrant} ${color} → ${url}`);
  }
  console.log(`  合計 ${(bytes / 1024).toFixed(0)} KB`);
}

console.log('リバリー生成 完了');
