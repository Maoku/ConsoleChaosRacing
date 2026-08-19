import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { ENTRANT_COUNT } from '../src/game/sim/state.js';
import {
  CAR_SPRITE_GEOMETRY,
  CAR_SPRITE_SOURCES,
  CAR_SPRITES,
  spriteRowFor,
} from '../src/game/view/shared/car-sprite.js';
import { ENTRANT_COLORS, PLAYER_ENTRANT } from '../src/game/view/shared/variants.js';
import { decodePng } from '../tools/lib/png.mjs';

/**
 * 第2世代のパレット替え（実装計画 11-1 / D-1）。
 *
 * 実機のスプライトは **1 タイルセット + パレット 16 色**で、色違いの敵車は
 * パレット番号だけを変えて作った。ここで固定するのはその構造そのもの —
 * **8 行の絵（インデックス地図）が完全に一致し、違うのは色だけ**であること。
 *
 * 「見た目が 8 色に分かれている」だけなら実行時の乗算でも作れるが、それだと
 * タイヤも窓も車体色に染まる。**構造を固定しておけば、絵を描き替えても
 * パレット替えであり続ける**ことがテストで守られる。
 */

const OPAQUE = 8;
const publicRoot = join(process.cwd(), 'public');

interface Band {
  /** 色の初出順に振り直した番号。透明は -1 */
  readonly map: Int16Array;
  /** 初出順の色（0xrrggbb） */
  readonly colors: readonly number[];
}

/**
 * 1 行ぶんを「インデックス地図 + パレット」へ戻す。
 *
 * 焼かれた PNG はパレット画像ではないので、**色の初出順**で番号を振り直して
 * インデックス地図を復元する。行どうしで地図が一致すれば、それは
 * 「同じ絵に別のパレットを当てた」ことの十分条件になる。
 */
function readBand(image: ReturnType<typeof decodePng>, row: number, cell: number): Band {
  const width = image.width;
  const map = new Int16Array(width * cell).fill(-1);
  const order = new Map<number, number>();
  for (let index = 0; index < width * cell; index++) {
    const offset = (row * cell * width + index) * 4;
    if (image.pixels[offset + 3]! < OPAQUE) continue;
    const color =
      (image.pixels[offset]! << 16) | (image.pixels[offset + 1]! << 8) | image.pixels[offset + 2]!;
    if (!order.has(color)) order.set(color, order.size);
    map[index] = order.get(color)!;
  }
  return { map, colors: [...order.keys()] };
}

function hueOf(color: number): number {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d < 1e-9) return 0;
  const hue = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return ((hue * 60) % 360 + 360) % 360;
}

function hexHue(hex: string): number {
  return hueOf(Number.parseInt(hex.slice(1), 16));
}

/** 色相の差 [deg]。0° と 359° は 1° 差 */
function hueGap(left: number, right: number): number {
  const gap = Math.abs(left - right) % 360;
  return gap > 180 ? 360 - gap : gap;
}

/** RGB555 の格子（各チャンネル 8 の倍数・248 で頭打ち）に乗っているか */
function onRgb555Grid(color: number): boolean {
  for (const channel of [(color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff]) {
    if (channel % 8 !== 0 || channel > 248) return false;
  }
  return true;
}

const sfc = CAR_SPRITE_GEOMETRY.SFC!;
const sfcSource = CAR_SPRITE_SOURCES.find((source) => source.generation === 'SFC')!;
const sfcImage = decodePng(readFileSync(join(publicRoot, sfcSource.to)));
const bands = Array.from({ length: sfc.rows }, (_unused, row) =>
  readBand(sfcImage, row, sfc.cell),
);

describe('第2世代のパレット替え', () => {
  it('出走台数ぶんの行がある（1 台 = 1 パレット）', () => {
    expect(sfc.perEntrant).toBe(true);
    expect(sfc.rows).toBe(ENTRANT_COUNT);
    expect(sfcImage.width).toBe(sfc.cell * sfc.columns);
    expect(sfcImage.height).toBe(sfc.cell * sfc.rows);
  });

  it('全行のインデックス地図が完全に一致する（絵は 1 つ・パレットだけ違う）', () => {
    const reference = bands[0]!.map;
    for (let row = 1; row < bands.length; row++) {
      const map = bands[row]!.map;
      let mismatch = -1;
      for (let index = 0; index < reference.length && mismatch < 0; index++) {
        if (reference[index] !== map[index]) mismatch = index;
      }
      expect(mismatch, `行 ${row} の画素 ${mismatch} が行 0 と違う`).toBe(-1);
    }
  });

  it('どの行も 16 色以内で、すべて RGB555 の格子に乗っている', () => {
    for (const [row, band] of bands.entries()) {
      // 透明を 1 色と数えるのが実機のパレット。焼くのは残りの 15 色まで
      expect(band.colors.length, `行 ${row} の色数`).toBeLessThanOrEqual(15);
      for (const color of band.colors) {
        expect(onRgb555Grid(color), `行 ${row} の #${color.toString(16)}`).toBe(true);
      }
    }
  });

  it('車体色の色相が ENTRANT_COLORS と一致し、共有色は 8 行で同一', () => {
    // 「行によって変わる色 = 塗装」「変わらない色 = タイヤ・窓・影・灯火」。
    // 番号で引けるのは上のテストで地図の一致を固定してあるから
    const body = new Set<number>();
    const shared = new Set<number>();
    for (let entry = 0; entry < bands[0]!.colors.length; entry++) {
      const colors = bands.map((band) => band.colors[entry]!);
      (new Set(colors).size === 1 ? shared : body).add(entry);
    }
    expect(body.size, '塗装の色数').toBeGreaterThan(0);
    expect(shared.size, '共有の色数').toBeGreaterThan(0);

    for (const [row, band] of bands.entries()) {
      const target = hexHue(ENTRANT_COLORS[row]!);
      for (const entry of body) {
        const color = band.colors[entry]!;
        // 明度の低い色は色相が読めない（黒に近い）ので、色の付いた塗装だけ見る
        const max = Math.max((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        const min = Math.min((color >> 16) & 0xff, (color >> 8) & 0xff, color & 0xff);
        if (max - min < 24) continue;
        expect(hueGap(hueOf(color), target), `行 ${row} の塗装 #${color.toString(16)}`).toBeLessThanOrEqual(12);
      }
    }
  });

  it('8 行ぶんの固有色の合計が 66 色以内（同時 256 色の予算に収まる）', () => {
    const total = new Set<number>();
    for (const band of bands) for (const color of band.colors) total.add(color);
    expect(total.size).toBeLessThanOrEqual(66);
  });

  it('第1世代は 2 行のまま（同時 25 色の契約・D-2）', () => {
    const fc = CAR_SPRITE_GEOMETRY.FC!;
    expect(fc.perEntrant).toBe(false);
    expect(fc.rows).toBe(2);
    const fcSource = CAR_SPRITE_SOURCES.find((source) => source.generation === 'FC')!;
    const image = decodePng(readFileSync(join(publicRoot, fcSource.to)));
    expect(image.height).toBe(fc.cell * fc.rows);
  });

  it('二度焼いてもバイト一致する（決定論）', () => {
    const before = CAR_SPRITE_SOURCES.map((source) => readFileSync(join(publicRoot, source.to)));
    execFileSync('npx', ['tsx', 'tools/build-car-sprites.mjs'], { cwd: process.cwd() });
    const after = CAR_SPRITE_SOURCES.map((source) => readFileSync(join(publicRoot, source.to)));
    for (const [index, source] of CAR_SPRITE_SOURCES.entries()) {
      expect(after[index]!.equals(before[index]!), `${source.to} が焼き直しで変わった`).toBe(true);
    }
  }, 60_000);

  describe('行の選び方', () => {
    it('第2世代はエントラント番号がそのまま行になる', () => {
      const atlas = CAR_SPRITES.SFC!;
      for (let entrant = 0; entrant < ENTRANT_COUNT; entrant++) {
        expect(spriteRowFor(atlas, entrant)).toBe(entrant);
      }
    });

    it('第1世代は自機 0・ライバル 1 の 2 行に落ちる', () => {
      const atlas = CAR_SPRITES.FC!;
      expect(spriteRowFor(atlas, PLAYER_ENTRANT)).toBe(0);
      for (let entrant = 1; entrant < ENTRANT_COUNT; entrant++) {
        expect(spriteRowFor(atlas, entrant)).toBe(1);
      }
    });
  });
});
