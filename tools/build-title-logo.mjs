#!/usr/bin/env tsx
/**
 * タイトルロゴ（実装計画 §2.6 / §3.7）。
 *
 *   npm run build:logo
 *
 * 256×64 を 1 セルのアトラスとして焼く（スプライトはアトラス経由でしか描けない）。
 * **1 枚で 4 世代ぶんを賄う** — FC では 54 色パレットへ、SFC では RGB555 へ
 * レンダラーが自動で量子化するので、世代ごとに焼き分ける必要が無い。
 * 配置と拡大率だけをビュー側の variant テーブルで変える。
 *
 * 字形は HUD と同じ `lib/glyphs.mjs` を拡大して使う。タイトルと HUD の書体が
 * 揃っているほうが 1 つの作品として見えるからで、当時のタイトルも多くがそうしていた。
 *
 * **半端な α を 1 画素も作らない。** FC は `translucency: none` で、スプライト面は
 * `a ≥ 0.5` のしきい値で合成される。中間の α を焼くと世代によって縁の出方が変わり、
 * さらに 54 色量子化のあとで濁る。影も縁取りも**不透明な単色**で置き、
 * 使う色は 6 つに抑えてある（§6.1 第1世代基準 1 の同時 25 色の予算）。
 *
 * 生成物はリポジトリにコミットする。二度実行してバイト一致すること（決定論）が要件。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LOGO_ATLAS } from '../src/game/view/shared/font.ts';
import { GLYPH_HEIGHT, GLYPH_WIDTH, forEachGlyphPixel } from './lib/glyphs.mjs';
import { Raster } from './lib/png.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const { width: WIDTH, height: HEIGHT } = LOGO_ATLAS;

/** 影と縁取りに共通の暗色。1 色で兼ねると FC の色数予算に優しい */
const DARK = [24, 24, 32];
const WHITE = [248, 248, 248];

/**
 * `RACING` の塗り。**連続した階調ではなく 4 段の帯**にする。
 * 滑らかに振っても FC / SFC の量子化で結局は段になるので、
 * 段の位置をこちらで決めておくほうが縁がきれいに出る。
 */
const RACING_BANDS = [
  { upTo: 0.26, color: [252, 252, 224] },
  { upTo: 0.57, color: [248, 216, 0] },
  { upTo: 0.83, color: [252, 152, 56] },
  { upTo: 1.01, color: [232, 56, 32] },
];

/** 2 行の組み。上は小さく白く、下を大きく置くのがレースゲームのロゴの型 */
const LINES = [
  { text: 'CONSOLE CHAOS', scale: 2, top: 3, outline: 1, shadow: 0, bands: null },
  { text: 'RACING', scale: 5, top: 20, outline: 2, shadow: 3, bands: RACING_BANDS },
];

/** 下端のチェッカーフラッグ帯 */
const CHECKER = { cell: 8, height: 6, bottomMargin: 1 };

/** 字送り。字形 5 px ＋ 隙間 1 px を拡大率ぶん広げる */
function advanceFor(scale) {
  return (GLYPH_WIDTH + 1) * scale;
}

function measure(text, scale) {
  return text.length * advanceFor(scale) - scale;
}

/** 文字列の点灯画素を 1 枚のマスクへ焼く（拡大は整数倍なので縁がぼけない） */
function stampText(text, scale, left, top) {
  const mask = new Uint8Array(WIDTH * HEIGHT);
  const advance = advanceFor(scale);
  for (let index = 0; index < text.length; index++) {
    const originX = left + index * advance;
    forEachGlyphPixel(text.charCodeAt(index), (glyphX, glyphY) => {
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const x = originX + glyphX * scale + dx;
          const y = top + glyphY * scale + dy;
          if (x >= 0 && y >= 0 && x < WIDTH && y < HEIGHT) mask[y * WIDTH + x] = 1;
        }
      }
    });
  }
  return mask;
}

/** マスクを `radius` 画素ぶん太らせた差分（＝縁取り） */
function outlineOf(mask, radius) {
  const out = new Uint8Array(WIDTH * HEIGHT);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (mask[y * WIDTH + x]) continue;
      let near = false;
      for (let dy = -radius; dy <= radius && !near; dy++) {
        for (let dx = -radius; dx <= radius && !near; dx++) {
          const sx = x + dx;
          const sy = y + dy;
          if (sx < 0 || sy < 0 || sx >= WIDTH || sy >= HEIGHT) continue;
          near = mask[sy * WIDTH + sx] === 1;
        }
      }
      if (near) out[y * WIDTH + x] = 1;
    }
  }
  return out;
}

function paint(raster, mask, colorAt) {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (mask[y * WIDTH + x]) raster.blend(x, y, colorAt(x, y), 1);
    }
  }
}

const raster = new Raster(WIDTH, HEIGHT);
const colors = new Set();
const noteColor = (color) => {
  colors.add(color.join(','));
  return color;
};

for (const line of LINES) {
  const textWidth = measure(line.text, line.scale);
  const left = Math.round((WIDTH - textWidth) / 2);
  const textHeight = GLYPH_HEIGHT * line.scale;
  const mask = stampText(line.text, line.scale, left, line.top);

  // 影 → 縁取り → 塗り の順に置く。影は縁取りごとずらした形にすると
  // 「板が浮いている」ように見えるので、字形そのものをずらして落とす
  if (line.shadow > 0) {
    const shadow = stampText(line.text, line.scale, left + line.shadow, line.top + line.shadow);
    paint(raster, shadow, () => noteColor(DARK));
  }
  paint(raster, outlineOf(mask, line.outline), () => noteColor(DARK));
  paint(raster, mask, (_x, y) => {
    if (!line.bands) return noteColor(WHITE);
    const t = (y - line.top) / (textHeight - 1);
    const band = line.bands.find((entry) => t <= entry.upTo) ?? line.bands[line.bands.length - 1];
    return noteColor(band.color);
  });

  console.log(`  "${line.text}" ×${line.scale} → ${textWidth}×${textHeight} px @ x=${left}`);
}

// ── チェッカーフラッグの帯。ロゴ本体（RACING）の幅に合わせて敷く
{
  const racing = LINES[1];
  const bandWidth = Math.round(measure(racing.text, racing.scale) / CHECKER.cell) * CHECKER.cell;
  const left = Math.round((WIDTH - bandWidth) / 2);
  const top = HEIGHT - CHECKER.bottomMargin - CHECKER.height;
  for (let y = 0; y < CHECKER.height; y++) {
    for (let x = 0; x < bandWidth; x++) {
      const dark = (Math.floor(x / CHECKER.cell) + Math.floor(y / (CHECKER.height / 2))) % 2 === 0;
      raster.blend(left + x, top + y, noteColor(dark ? DARK : WHITE), 1);
    }
  }
  console.log(`  チェッカー帯 ${bandWidth}×${CHECKER.height} px @ x=${left}, y=${top}`);
}

const relativePath = `public/${LOGO_ATLAS.url}`;
const absolute = join(repoRoot, relativePath);
mkdirSync(dirname(absolute), { recursive: true });
// アトラスは flipY:false で取り込まれるので、画面座標系で描いた図を上下反転して渡す。
// ロゴは 1 セルなので画像ぜんたいを反転すればよい（`build-minimap.mjs` と同じ）
const png = raster.flipVertical().toPng();
writeFileSync(absolute, png);

console.log(`${relativePath} ${WIDTH}×${HEIGHT} / ${colors.size} 色 / ${png.length} B`);
console.log('タイトルロゴ生成 完了');
