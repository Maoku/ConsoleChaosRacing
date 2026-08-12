#!/usr/bin/env tsx
/**
 * 第1世代のラスタースクロール用・広い路面テクスチャ（実装計画 §3.2 / §8）。
 *
 *   npm run build:road
 *
 * 同梱の `road.png` は路面がテクスチャ幅の 44.5% を占めるため、エンジンの
 * 「走査線 `width` は (0, 1]」という制限に当たって路面が画面の半分より細くならない
 * （理由は `src/game/view/shared/road-surface.ts` の冒頭に書いた）。
 * ここでは路面をテクスチャ幅の 1/7 に収めた版を焼き、描画距離を伸ばす。
 *
 * **縦方向（V）は進行方向の距離**であり、1 枚が `periodMeters` を表す。
 * 走査線ごとに `sourceV = fract((s0 + z) / periodMeters)` を書き込むので、
 * センターラインと縁石の縞がそのまま速度計になる。
 *
 * **横方向（U）は静的なパターンだけにしてある。** V 方向に高周波な模様を入れると、
 * 遠方の行（1 行が数十メートルを跨ぐ）でちらつきが出るため。
 * 草の陰影は路面からの距離だけで決めており、走っても動かない。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROAD_COLORS, ROAD_SURFACE } from '../src/game/view/shared/road-surface.ts';
import { encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** '#rrggbb' → [r, g, b] */
function rgb(hex) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

const layout = ROAD_SURFACE;
const { textureWidth: width, textureHeight: height } = layout;
/** テクスチャ 1 画素が表す横方向の距離 [m] */
const metersPerPixelU = layout.spanMeters / width;
/** テクスチャ 1 画素が表す進行方向の距離 [m] */
const metersPerPixelV = layout.periodMeters / height;

const asphalt = rgb(ROAD_COLORS.asphalt);
const line = rgb(ROAD_COLORS.line);
const kerbRed = rgb(ROAD_COLORS.kerbRed);
const kerbPale = rgb(ROAD_COLORS.kerbPale);
const runoff = rgb(ROAD_COLORS.runoff);
const grass = [rgb(ROAD_COLORS.grassNear), rgb(ROAD_COLORS.grassFar)];

const dashPeriod = layout.dashMeters + layout.dashGapMeters;
const kerbPeriod = layout.kerbStripeMeters * 2;

/**
 * 位置 (lateral [m], along [m]) の色。
 * `lateral` は路面中心からの符号付き距離、`along` は 0..periodMeters。
 */
function sample(lateral, along) {
  const distance = Math.abs(lateral);

  if (distance <= layout.roadHalfWidth) {
    // センターライン（破線）
    if (distance <= layout.lineWidth / 2 && along % dashPeriod < layout.dashMeters) return line;
    // 路肩線（実線）
    if (Math.abs(distance - layout.edgeLineOffset) <= layout.lineWidth / 2) return line;
    return asphalt;
  }

  if (distance <= layout.roadHalfWidth + layout.kerbWidth) {
    return along % kerbPeriod < layout.kerbStripeMeters ? kerbRed : kerbPale;
  }

  if (distance <= layout.roadHalfWidth + layout.kerbWidth + layout.runoffWidth) return runoff;

  // 草地は路面から離れるほど暗くする。遠近ではなく横方向の広がりを出すための階調
  const outside = distance - (layout.roadHalfWidth + layout.kerbWidth + layout.runoffWidth);
  return outside < layout.grassBandWidth ? grass[0] : grass[1];
}

const pixels = Buffer.alloc(width * height * 4);
for (let y = 0; y < height; y++) {
  // 画素の中心を採る。端で半画素ずれると路面幅がテクスチャ幅の 1/1024 だけ狂う
  const along = (y + 0.5) * metersPerPixelV;
  for (let x = 0; x < width; x++) {
    const lateral = (x + 0.5 - width / 2) * metersPerPixelU;
    const [red, green, blue] = sample(lateral, along);
    const offset = (y * width + x) * 4;
    pixels[offset] = red;
    pixels[offset + 1] = green;
    pixels[offset + 2] = blue;
    pixels[offset + 3] = 255;
  }
}

const relativePath = `public/${layout.texture}`;
const absolute = join(repoRoot, relativePath);
mkdirSync(dirname(absolute), { recursive: true });
const png = encodePng(width, height, pixels);
writeFileSync(absolute, png);

const roadPixels = Math.round(((layout.roadHalfWidth * 2) / layout.spanMeters) * width);
console.log(
  `${layout.texture} ${width}×${height} / 横 ${layout.spanMeters} m・縦 ${layout.periodMeters} m`,
);
console.log(
  `  路面 ${roadPixels} px（テクスチャ幅の ${((roadPixels / width) * 100).toFixed(1)}%）` +
    ` / ${(png.length / 1024).toFixed(0)} KB`,
);
