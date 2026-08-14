#!/usr/bin/env tsx
/**
 * 背景オブジェクトのスプライト／ビルボード（実装計画 §2.6 / 8-6 / 8-10）。
 *
 *   npm run build:scenery
 *
 * **セルいっぱいに描く**ので、`SCENERY_ART` の縦横比がそのままスプライトの
 * 縦横比になる（車のセルと違って透明な余りを持たない ＝ 引き伸ばしても縮まない）。
 *
 * **セルの中で上下を反転して焼く。** レンダラーはアトラスを `flipY: false` で取り込み、
 * スクリーン空間スプライトのクアッドは画像の上端をスプライトの下端へ割り当てるため
 * （車スプライト・フォントと同じ規約）。ワールド空間のビルボードにはその反転が無いので、
 * `flipCells` で焼き方を分ける。
 *
 * 色は世代ごとに変える。**FC は 54 色マスターパレットの値そのもの**を置く —
 * 外れた色は最近傍で隣へ落ち、塗り分けがそのまま消えるため（§3.2）。
 * SFC は RGB555 の格子（各チャンネル 8 の倍数）。半透明は 1 画素も作らない。
 *
 * ## 第4世代だけ絵が違う（8-10）
 *
 * 第1〜第3世代は 3 セル 1 行・1 種類につき 1 枚。第4世代は 3 × 2 の 6 セルで、
 * **木 3 種・看板 2 種**を持つ。同じ 25 m 間隔の並木でも隣と形が違うので、
 * 「同じ絵の反復」に見えない。セルも 128² → 256² に上げ、枝の分かれ目・葉の塊の
 * 陰・幹の樹皮まで描く。光の向きは環境マップから実測した `SUN_DIRECTION` に合わせる
 * ので、**木の陰と車体の陰影と映り込みの太陽が 3 つとも同じ向き**になる。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GENERATION_IDS } from '@console-chaos/engine';

import { SUN_DIRECTION } from '../src/game/view/shared/environment.ts';
import {
  SCENERY_BILLBOARDS,
  SCENERY_SPRITES,
} from '../src/game/view/shared/scenery-sprite.ts';
import { Raster, encodePng } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

// ─────────────────────────────────────────────────────────────
// 第1〜第3世代（1 種類につき 1 枚・平坦な塗り分け）
// ─────────────────────────────────────────────────────────────

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

// ─────────────────────────────────────────────────────────────
// 第4世代（8-10）
// ─────────────────────────────────────────────────────────────

/**
 * 絵の中の光の向き（画面の左右・上下）。
 *
 * `SUN_DIRECTION` は**光の側へ向かう**ワールドのベクトル。ビルボードはカメラを
 * 向いて回るので方位は決まらないが、**仰角は回っても変わらない**。
 * 横成分は太陽の方位の符号だけを使い、縦は仰角そのものを使う。
 * これで木の陰の向きが、車体の陰影・映り込みの太陽と食い違わない。
 */
const LIGHT = (() => {
  const elevation = SUN_DIRECTION[1];
  const horizontal = Math.hypot(SUN_DIRECTION[0], SUN_DIRECTION[2]);
  const side = SUN_DIRECTION[0] < 0 ? -1 : 1;
  const length = Math.hypot(horizontal, elevation) || 1;
  return { x: (side * horizontal) / length, y: -elevation / length };
})();

/** 決定論的な 0..1 のハッシュ（`Math.random` は使わない） */
function hash(x, y, seed) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

/** 2 色を混ぜる */
function mix(a, b, t) {
  const k = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

/**
 * 葉の塊を 1 つ。中心 (cx, cy)・半径 r の球として陰を付ける。
 *
 * 輪郭はハッシュで削って**円に見えないように**する。ここを丸いままにすると、
 * どれだけ陰を付けても「緑の玉」にしか見えない。
 */
function paintCanopy(raster, cell, blob, palette, seed) {
  const { x: cx, y: cy, radius, flatten = 1 } = blob;
  const from = Math.max(0, Math.floor(cx - radius - 2));
  const to = Math.min(cell, Math.ceil(cx + radius + 2));
  const top = Math.max(0, Math.floor(cy - radius * flatten - 2));
  const bottom = Math.min(cell, Math.ceil(cy + radius * flatten + 2));

  for (let y = top; y < bottom; y++) {
    for (let x = from; x < to; x++) {
      const dx = (x + 0.5 - cx) / radius;
      const dy = (y + 0.5 - cy) / (radius * flatten);
      const distance = Math.hypot(dx, dy);
      // 輪郭の揺らぎ。房のかたまりに見せる
      const ragged = 0.86 + 0.2 * hash(Math.floor(x / 3), Math.floor(y / 3), seed);
      if (distance > ragged) continue;
      // 球としての陰。光の側が明るく、反対側の縁が落ちる
      const lambert = Math.max(0, -(dx * LIGHT.x + dy * LIGHT.y)) * (1 - distance * 0.25);
      const speckle = hash(x, y, seed + 3) * 0.16 - 0.08;
      const shade = Math.min(1, Math.max(0, 0.26 + lambert * 0.95 + speckle));
      raster.blend(x, y, mix(palette.leafDark, palette.leafLight, shade), 1);
    }
  }
}

/** 幹と枝。太さは根元から先へ細くする */
function paintTrunk(raster, cell, trunk, palette) {
  const { width, top, lean = 0 } = trunk;
  for (let y = top; y < cell; y++) {
    const t = (y - top) / (cell - top);
    const half = (width * (0.55 + 0.45 * t)) / 2;
    const center = cell / 2 + lean * (1 - t) * cell * 0.06;
    for (let x = Math.floor(center - half); x <= Math.ceil(center + half); x++) {
      const across = (x + 0.5 - center) / Math.max(1, half);
      // 円柱としての陰 ＋ 樹皮の縦筋
      const lambert = Math.max(0, -across * LIGHT.x) * 0.8 + 0.3;
      const bark = hash(x, Math.floor(y / 2), 9) * 0.22 - 0.11;
      const shade = Math.min(1, Math.max(0.15, lambert + bark));
      raster.blend(x, y, mix([28, 18, 12], palette.trunk, shade), 1);
    }
  }
}

/** 広葉樹。房を 5 つ重ねて樹冠を作る */
function drawBroadleaf(palette, cell, variant) {
  const raster = new Raster(cell, cell);
  const seed = variant * 17 + 1;
  paintTrunk(raster, cell, { width: cell * 0.1, top: cell * 0.56, lean: variant === 1 ? 1 : 0 }, palette);

  const blobs =
    variant === 0
      ? [
          { x: cell * 0.5, y: cell * 0.3, radius: cell * 0.3 },
          { x: cell * 0.28, y: cell * 0.42, radius: cell * 0.21 },
          { x: cell * 0.72, y: cell * 0.4, radius: cell * 0.22 },
          { x: cell * 0.44, y: cell * 0.15, radius: cell * 0.19 },
          { x: cell * 0.6, y: cell * 0.55, radius: cell * 0.17 },
        ]
      : [
          { x: cell * 0.46, y: cell * 0.34, radius: cell * 0.27, flatten: 0.82 },
          { x: cell * 0.7, y: cell * 0.28, radius: cell * 0.2 },
          { x: cell * 0.26, y: cell * 0.3, radius: cell * 0.18 },
          { x: cell * 0.55, y: cell * 0.12, radius: cell * 0.16 },
          { x: cell * 0.38, y: cell * 0.5, radius: cell * 0.16 },
        ];
  for (const [index, blob] of blobs.entries()) {
    paintCanopy(raster, cell, blob, palette, seed + index * 5);
  }
  return raster;
}

/** 針葉樹。三角の段を 5 つ重ねる。並木の中で背が高く尖って見える */
function drawConifer(palette, cell) {
  const raster = new Raster(cell, cell);
  // 幹はいちばん下の段の内側から出る。段より上で切ると木が宙に浮く
  paintTrunk(raster, cell, { width: cell * 0.07, top: cell * 0.82 }, palette);

  const tiers = 5;
  for (let tier = 0; tier < tiers; tier++) {
    const top = cell * (0.02 + tier * 0.165);
    const bottom = cell * (0.3 + tier * 0.145);
    const half = cell * (0.085 + tier * 0.056);
    for (let y = Math.floor(top); y < Math.ceil(bottom); y++) {
      const along = (y - top) / (bottom - top);
      const width = half * (0.15 + along);
      const ragged = 1 + 0.12 * hash(Math.floor(y / 2), tier, 21);
      for (let x = Math.floor(cell / 2 - width * ragged); x <= Math.ceil(cell / 2 + width * ragged); x++) {
        const across = (x + 0.5 - cell / 2) / Math.max(1, width);
        if (Math.abs(across) > ragged) continue;
        const lambert = Math.max(0, -(across * LIGHT.x + (along - 0.6) * LIGHT.y));
        const speckle = hash(x, y, 30 + tier) * 0.18 - 0.09;
        const shade = Math.min(1, Math.max(0, 0.18 + lambert * 0.8 + speckle));
        raster.blend(x, y, mix([20, 52, 34], [64, 118, 58], shade), 1);
      }
    }
  }
  return raster;
}

/**
 * 看板。第4世代だけ 2 種類ある。
 *
 * - `variant 0`: コーナーの警告板（黄地に黒の矢印）。2 本脚で立つ
 * - `variant 1`: 距離標識（3 本の斜線）。コーナー入口の定番
 */
function drawBoard(palette, cell, variant) {
  const raster = new Raster(cell, cell);
  const boardBottom = Math.round(cell * 0.6);
  const legWidth = Math.max(2, Math.round(cell * 0.045));

  // 2 本脚。1 本より構造物らしく見える
  for (const offset of [-0.16, 0.16]) {
    const center = cell / 2 + offset * cell;
    for (let y = boardBottom; y < cell; y++) {
      for (let x = 0; x < legWidth; x++) {
        const shade = 0.55 + 0.45 * (1 - x / legWidth);
        raster.blend(Math.round(center) + x, y, mix([48, 48, 46], palette.signPost, shade), 1);
      }
    }
  }

  const face = variant === 0 ? [232, 196, 48] : palette.signFace;
  const ink = variant === 0 ? [32, 30, 28] : palette.signInk;
  const margin = Math.round(cell * 0.04);
  for (let y = margin; y < boardBottom - margin; y++) {
    for (let x = margin; x < cell - margin; x++) {
      const border =
        Math.min(x - margin, y - margin, cell - margin - 1 - x, boardBottom - margin - 1 - y) <
        cell * 0.035;
      // 上から下へわずかに暗く（面としての傾きが読める）
      const shade = 1 - ((y - margin) / boardBottom) * 0.16;
      raster.blend(x, y, border ? ink : mix([0, 0, 0], face, shade), 1);
    }
  }

  if (variant === 0) {
    // 右へ曲がる矢印。太い軸と三角の頭
    const midY = boardBottom * 0.5;
    const shaft = Math.round(cell * 0.07);
    for (let x = Math.round(cell * 0.2); x < Math.round(cell * 0.62); x++) {
      for (let y = Math.round(midY - shaft / 2); y < Math.round(midY + shaft / 2); y++) {
        raster.blend(x, y, ink, 1);
      }
    }
    for (let step = 0; step < Math.round(cell * 0.2); step++) {
      const x = Math.round(cell * 0.6) + step;
      const half = Math.round(cell * 0.16) - step * 0.8;
      for (let y = Math.round(midY - half); y < Math.round(midY + half); y++) {
        raster.blend(x, y, ink, 1);
      }
    }
  } else {
    // 距離標識の 3 本の斜線
    for (let bar = 0; bar < 3; bar++) {
      const start = cell * (0.2 + bar * 0.2);
      for (let y = Math.round(cell * 0.12); y < Math.round(boardBottom * 0.85); y++) {
        const slant = (y - cell * 0.12) * 0.45;
        for (let x = 0; x < Math.round(cell * 0.09); x++) {
          raster.blend(Math.round(start + slant) + x, y, ink, 1);
        }
      }
    }
  }
  return raster;
}

/** 第4世代のタイヤフェンス（アトラスの体裁を保つためだけに焼く。実際はメッシュで置く） */
function drawTyreCell(palette, cell) {
  return drawTyres(palette, cell);
}

// ─────────────────────────────────────────────────────────────

/**
 * セルのラスタをアトラスへ貼る。`flip` のときだけ**セルの中で上下を反転する**。
 *
 * スクリーン空間スプライト（擬似3D 世代）はクアッドが `ortho(0, W, H, 0)` を通り、
 * 画像の上端がスプライトの下端へ割り当たるので反転して焼くのが正しい。
 * ワールド空間のビルボード（3D 世代）にはその反転が無いため、同じ絵を貼ると
 * **木が逆さまに立つ**（実画面で確認）。焼き方をここで分ける。
 */
function blit(atlas, source, index, columns, cell, flip) {
  const originX = (index % columns) * cell;
  const originY = Math.floor(index / columns) * cell;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const from = ((flip ? cell - 1 - y : y) * cell + x) * 4;
      const to = ((originY + y) * atlas.width + originX + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        atlas.pixels[to + channel] = source.pixels[from + channel];
      }
    }
  }
}

/** そのセル番号に描く絵。第4世代だけ 6 セルぶんの割り当てを持つ */
function cellPainter(layout, palette, cell, index) {
  if (layout.cells.tree.length === 1) {
    return [
      () => drawSign(palette, cell),
      () => drawTree(palette, cell),
      () => drawTyres(palette, cell),
    ][index]();
  }
  return [
    () => drawBoard(palette, cell, 0),
    () => drawBroadleaf(palette, cell, 0),
    () => drawTyreCell(palette, cell),
    () => drawBroadleaf(palette, cell, 1),
    () => drawConifer(palette, cell),
    () => drawBoard(palette, cell, 1),
  ][index]();
}

for (const generation of GENERATION_IDS) {
  // 擬似3D 世代はスクリーン空間スプライト、3D 世代はワールド空間のビルボード。
  // 使い方は違うが**焼く絵は同じ 1 つの生成器**から出る（8-6）
  const atlasSpec = SCENERY_SPRITES[generation] ?? SCENERY_BILLBOARDS[generation];
  if (!atlasSpec) continue;
  const palette = PALETTES[generation];
  if (!palette) throw new Error(`${generation} の色が定義されていない`);

  const { layout, cellSize: cell, flipCells: flip } = atlasSpec;
  const atlas = new Raster(cell * layout.columns, cell * layout.rows);
  for (let index = 0; index < layout.columns * layout.rows; index++) {
    blit(atlas, cellPainter(layout, palette, cell, index), index, layout.columns, cell, flip);
  }

  const png = encodePng(atlas.width, atlas.height, atlas.pixels);
  const relativePath = `public/${atlasSpec.url}`;
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
    `${generation}: ${atlasSpec.url} ${atlas.width}×${atlas.height}` +
      `（${layout.columns}×${layout.rows} セル）/ ${colors.size} 色 / ` +
      `出す種類 ${atlasSpec.kinds.join('・')} / ` +
      `${flip ? '上下反転（スクリーン空間）' : 'そのまま（ビルボード）'} / ` +
      `${(png.length / 1024).toFixed(1)} KB`,
  );
}

console.log('背景オブジェクト生成 完了');
