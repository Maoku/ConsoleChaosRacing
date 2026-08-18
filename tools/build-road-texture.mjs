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

import { ROAD_SURFACES, roadFraction, roadSurfaceColorAt } from '../src/game/view/shared/road-surface.ts';
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

function render(layout) {
  const { textureWidth: width, textureHeight: height } = layout;
  /** テクスチャ 1 画素が表す横方向の距離 [m] */
  const metersPerPixelU = layout.spanMeters / width;
  /** テクスチャ 1 画素が表す進行方向の距離 [m] */
  const metersPerPixelV = layout.periodMeters / height;

  // 断面の定義は `road-surface.ts` の 1 か所。ここは走査と色の変換だけを持つ
  const palette = new Map();
  const toRgb = (hex) => {
    let value = palette.get(hex);
    if (!value) {
      value = rgb(hex);
      palette.set(hex, value);
    }
    return value;
  };

  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    // 画素の中心を採る。端で半画素ずれると路面幅がテクスチャ幅の 1/1024 だけ狂う
    const along = (y + 0.5) * metersPerPixelV;
    for (let x = 0; x < width; x++) {
      const lateral = (x + 0.5 - width / 2) * metersPerPixelU;
      const [red, green, blue] = toRgb(roadSurfaceColorAt(layout, lateral, along));
      const offset = (y * width + x) * 4;
      pixels[offset] = red;
      pixels[offset + 1] = green;
      pixels[offset + 2] = blue;
      pixels[offset + 3] = 255;
    }
  }

  return { png: encodePng(width, height, pixels), pixels };
}

/**
 * ユニークな N×N タイルを数える（実装計画 8-2）。
 *
 * 実機の BG 面はタイルの実体を 256 種しか置けない。**全画素ユニークな絵は
 * 当時のハードウェアには焼けない情報量**であり、それが遠方のちらつきになる。
 * 数えて上限を超えたら生成を失敗させ、実機に無い絵をリポジトリへ入れない。
 */
function countUniqueTiles(pixels, width, height, size) {
  if (width % size !== 0 || height % size !== 0) {
    throw new Error(`${width}×${height} を ${size} px タイルで割り切れない`);
  }
  const tiles = new Set();
  for (let tileY = 0; tileY < height / size; tileY++) {
    for (let tileX = 0; tileX < width / size; tileX++) {
      const bytes = Buffer.alloc(size * size * 4);
      for (let y = 0; y < size; y++) {
        const from = ((tileY * size + y) * width + tileX * size) * 4;
        pixels.copy(bytes, y * size * 4, from, from + size * 4);
      }
      tiles.add(bytes.toString('base64'));
    }
  }
  return tiles.size;
}

for (const generation of GENERATION_IDS) {
  const layout = ROAD_SURFACES[generation];
  if (!layout) continue;

  const { png, pixels } = render(layout);

  if (layout.tileGrid) {
    const { size, maxUniqueTiles } = layout.tileGrid;
    const unique = countUniqueTiles(pixels, layout.textureWidth, layout.textureHeight, size);
    if (unique > maxUniqueTiles) {
      throw new Error(
        `${generation}: ユニークな ${size}×${size} タイルが ${unique} 種（上限 ${maxUniqueTiles}）。` +
          '実機の BG 面には焼けない情報量なので、模様の境目をタイル境界へ寄せるか密度を落とす',
      );
    }
    console.log(`${generation}: ユニークタイル ${unique} / ${maxUniqueTiles} 種（${size}×${size}）`);
  }
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
