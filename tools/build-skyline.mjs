#!/usr/bin/env tsx
/**
 * 環境マップ → 第4世代の遠景の帯（実装計画 §2.6 / §3.4）。
 *
 *   npm run build:skyline
 *
 * 同じ 1 枚の環境マップから空と映り込みを出す、というのが第4世代の要求
 * （§6.1 第4世代基準 2「空と映り込みが同じ環境マップで一致している」）。
 * ところが `BackgroundCommand.texture` と `MaterialCommand.environmentTexture` は
 * **要求する flipY が逆**で、1 つの登録では両立しない（`shared/environment.ts` の表）。
 * そこで地平線まわりの帯だけを切り出し、遠景の層にはそちらを渡す。
 *
 * 切り出しと同時に、地平線より下の「撮影地のコース」を一様な霞へ溶かす。
 * 残すと自分たちの 3D コースの左右に二本目の道路が現れる。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ENVIRONMENT_MAP,
  SKY_SAMPLE,
  SKYLINE,
  equirectElevation,
  equirectV,
  skylineRows,
} from '../src/game/view/shared/environment.ts';
import { decodePng, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseHex(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

function toHex(rgb) {
  return `#${rgb.map((value) => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
}

/** 仰角の範囲にある行の平均色。空の階調とフォグ色の実測に使う */
function meanColor(image, fromElevation, toElevation) {
  const from = Math.round(equirectV(fromElevation) * image.height);
  const to = Math.round(equirectV(toElevation) * image.height);
  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let y = from; y < to; y++) {
    for (let x = 0; x < image.width; x++) {
      const index = (y * image.width + x) * 4;
      r += image.pixels[index];
      g += image.pixels[index + 1];
      b += image.pixels[index + 2];
      count += 1;
    }
  }
  return count === 0 ? [0, 0, 0] : [r / count, g / count, b / count];
}

const source = decodePng(readFileSync(join(repoRoot, 'public', ENVIRONMENT_MAP.url)));
if (source.width !== ENVIRONMENT_MAP.width || source.height !== ENVIRONMENT_MAP.height) {
  throw new Error(
    `環境マップの実寸 ${source.width}×${source.height} が ENVIRONMENT_MAP と食い違う`,
  );
}

const zenith = meanColor(source, SKY_SAMPLE.zenith.from, SKY_SAMPLE.zenith.to);
const haze = meanColor(source, SKY_SAMPLE.haze.from, SKY_SAMPLE.haze.to);
const surface = meanColor(source, SKY_SAMPLE.ground.from, SKY_SAMPLE.ground.to);
// 地表を地平の霞へ寄せる。遠いものほど霞むという当たり前の性質を 1 行で入れる
const ground = surface.map(
  (value, channel) => value * (1 - SKYLINE.groundHaze) + haze[channel] * SKYLINE.groundHaze,
);

const [rowFrom, rowTo] = skylineRows(source.height);
const height = rowTo - rowFrom;
const pixels = Buffer.alloc(source.width * height * 4);

for (let row = 0; row < height; row++) {
  const elevation = equirectElevation((rowFrom + row + 0.5) / source.height);
  // 地平線の少し下から地表の霞へ溶かす。0 なら元の絵、1 なら一様な霞
  const fade = Math.min(
    1,
    Math.max(
      0,
      (SKYLINE.groundFadeFrom - elevation) / (SKYLINE.groundFadeFrom - SKYLINE.groundFadeTo),
    ),
  );
  for (let x = 0; x < source.width; x++) {
    const from = ((rowFrom + row) * source.width + x) * 4;
    const to = (row * source.width + x) * 4;
    for (let channel = 0; channel < 3; channel++) {
      pixels[to + channel] = Math.round(
        source.pixels[from + channel] * (1 - fade) + ground[channel] * fade,
      );
    }
    // 層は不透明。空の階調が透けると、帯の縁が横線として見える
    pixels[to + 3] = 255;
  }
}

const absolute = join(repoRoot, 'public', SKYLINE.url);
mkdirSync(dirname(absolute), { recursive: true });
const png = encodePng(source.width, height, pixels);
writeFileSync(absolute, png);

console.log(
  `遠景の帯 ${source.width}×${height}` +
    `（仰角 ${((SKYLINE.topAngle * 180) / Math.PI).toFixed(0)}° … ` +
    `${((SKYLINE.bottomAngle * 180) / Math.PI).toFixed(0)}° / 元の行 ${rowFrom}–${rowTo}）` +
    ` / ${(png.length / 1024).toFixed(0)} KB`,
);
console.log(`  → ${SKYLINE.url}`);
console.log('環境マップから実測した色（コード側の定数と突き合わせる）:');
console.log(`  天頂       ${toHex(zenith)}  … SKY_COLORS.PS2.top`);
console.log(`  地平の霞   ${toHex(haze)}  … SKY_COLORS.PS2.bottom（＝フォグ色）`);
console.log(`  地表       ${toHex(surface)} → 潰した先 ${toHex(ground)}`);
