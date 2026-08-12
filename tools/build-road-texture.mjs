#!/usr/bin/env tsx
/**
 * 擬似3D世代の路面テクスチャ（実装計画 §3.2 / §3.3 / §8）。
 *
 *   npm run build:road
 *
 * 第1世代（ラスタースクロール）と第2世代（アフィン面）の 2 枚を、
 * **同じ 1 つの生成器**で焼く。路面幅・縁石・破線の寸法はどちらもメートルで
 * 定義されており（`src/game/view/shared/road-surface.ts`）、世代差は
 * 「テクスチャ 1 枚が表す広さ」と「色数」だけになる。
 *
 * 同梱の `road.png` は路面がテクスチャ幅の 44.5% を占めるため、エンジンの
 * 「走査線 `width` は (0, 1]」という制限に当たって路面が画面の半分より細くならない
 * （理由は `road-surface.ts` の冒頭に書いた）。第2世代の `circuit.png` は
 * 草地のディザが遠方でちらつく。どちらも入力としては残し、描くのはこの生成物のほう。
 *
 * **縦方向（V）は進行方向の距離**であり、1 枚が `periodMeters` を表す。
 * 走査線ごとに `sourceV = fract((s0 + z) / periodMeters)` を書き込むので、
 * センターラインと縁石の縞がそのまま速度計になる。
 *
 * **横方向（U）は静的なパターンだけにしてある。** V 方向に高周波な模様を入れると、
 * 遠方の行（1 行が数十メートルを跨ぐ）でちらつきが出るため。
 * 草の陰影も路面からの距離だけで決めており、走っても動かない。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { ROAD_SURFACES, roadFraction } from '../src/game/view/shared/road-surface.ts';
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

/**
 * 位置 (lateral [m], along [m]) の色。
 * `lateral` は路面中心からの符号付き距離、`along` は 0..periodMeters。
 */
function sample(layout, palette, lateral, along) {
  const distance = Math.abs(lateral);
  const dashPeriod = layout.dashMeters + layout.dashGapMeters;
  const kerbPeriod = layout.kerbStripeMeters * 2;

  if (distance <= layout.roadHalfWidth) {
    // センターライン（破線）
    if (distance <= layout.lineWidth / 2 && along % dashPeriod < layout.dashMeters) {
      return palette.line;
    }
    // 路肩線（実線）
    if (Math.abs(distance - layout.edgeLineOffset) <= layout.lineWidth / 2) return palette.line;
    // 路肩寄りの摩耗。色数に余裕のある世代だけで、舗装の幅を目で読ませる
    if (distance > layout.roadHalfWidth - layout.wearWidth) return palette.asphaltWorn;
    return palette.asphalt;
  }

  if (distance <= layout.roadHalfWidth + layout.kerbWidth) {
    return along % kerbPeriod < layout.kerbStripeMeters ? palette.kerbRed : palette.kerbPale;
  }

  if (distance <= layout.roadHalfWidth + layout.kerbWidth + layout.runoffWidth) {
    return palette.runoff;
  }

  // 草地は路面から離れるほど暗くする。遠近ではなく横方向の広がりを出すための階調
  let outside = distance - (layout.roadHalfWidth + layout.kerbWidth + layout.runoffWidth);
  for (const band of palette.grass) {
    if (outside < band.width) return band.color;
    outside -= band.width;
  }
  return palette.grass[palette.grass.length - 1].color;
}

function render(layout) {
  const { textureWidth: width, textureHeight: height } = layout;
  /** テクスチャ 1 画素が表す横方向の距離 [m] */
  const metersPerPixelU = layout.spanMeters / width;
  /** テクスチャ 1 画素が表す進行方向の距離 [m] */
  const metersPerPixelV = layout.periodMeters / height;

  const palette = {
    asphalt: rgb(layout.colors.asphalt),
    asphaltWorn: rgb(layout.colors.asphaltWorn),
    line: rgb(layout.colors.line),
    kerbRed: rgb(layout.colors.kerbRed),
    kerbPale: rgb(layout.colors.kerbPale),
    runoff: rgb(layout.colors.runoff),
    grass: layout.colors.grass.map((band) => ({ width: band.width, color: rgb(band.color) })),
  };

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    // 画素の中心を採る。端で半画素ずれると路面幅がテクスチャ幅の 1/1024 だけ狂う
    const along = (y + 0.5) * metersPerPixelV;
    for (let x = 0; x < width; x++) {
      const lateral = (x + 0.5 - width / 2) * metersPerPixelU;
      const [red, green, blue] = sample(layout, palette, lateral, along);
      const offset = (y * width + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }

  return encodePng(width, height, pixels);
}

for (const generation of GENERATION_IDS) {
  const layout = ROAD_SURFACES[generation];
  if (!layout) continue;

  const png = render(layout);
  const relativePath = `public/${layout.texture}`;
  const absolute = join(repoRoot, relativePath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, png);

  const roadPixels = Math.round(roadFraction(layout) * layout.textureWidth);
  console.log(
    `${generation}: ${layout.texture} ${layout.textureWidth}×${layout.textureHeight}` +
      ` / 横 ${layout.spanMeters} m・縦 ${layout.periodMeters} m`,
  );
  console.log(
    `  路面 ${roadPixels} px（テクスチャ幅の ${((roadPixels / layout.textureWidth) * 100).toFixed(1)}%）` +
      ` / ${(png.length / 1024).toFixed(0)} KB`,
  );
}
