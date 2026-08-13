import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { backdropFor } from '../src/game/view/shared/backdrop.js';
import {
  patternPeriodMeters,
  roadSurfaceFor,
  type RoadSurfaceLayout,
} from '../src/game/view/shared/road-surface.js';
import { decodePng } from '../tools/lib/png.mjs';

/**
 * 焼いた路面テクスチャが実機の BG スペックに収まっているか（実装計画 8-2）。
 *
 * SFC の Mode 7 面は 128×128 タイルだが、**タイルの実体は 256 種**しか置けない。
 * 全画素ユニークな絵は当時のハードウェアに焼けない情報量を持っており、
 * それが遠方の走査線のちらつきとして出ていた。ここで固定するのは 3 つ。
 *
 * 1. ユニークな 8×8 タイルが 256 種以内
 * 2. 全画素が RGB555 の格子（各チャンネル 8 の倍数）に載っている
 * 3. V 方向の模様の境目がタイル境界に載っている（＝タイル数が増えない作り）
 */

function load(layout: RoadSurfaceLayout) {
  return decodePng(readFileSync(join(process.cwd(), 'public', layout.texture)));
}

function uniqueTiles(
  image: { width: number; height: number; pixels: Buffer },
  size: number,
): number {
  const tiles = new Set<string>();
  for (let tileY = 0; tileY < image.height / size; tileY++) {
    for (let tileX = 0; tileX < image.width / size; tileX++) {
      const bytes: number[] = [];
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) {
          const offset = ((tileY * size + y) * image.width + tileX * size + x) * 4;
          bytes.push(
            image.pixels[offset]!,
            image.pixels[offset + 1]!,
            image.pixels[offset + 2]!,
            image.pixels[offset + 3]!,
          );
        }
      }
      tiles.add(bytes.join(','));
    }
  }
  return tiles.size;
}

describe('路面テクスチャ', () => {
  const sfc = roadSurfaceFor('SFC')!;

  it('SFC は BG のタイル制約を持ち、FC のラスター面は持たない', () => {
    // ラスター面は走査線ごとに U を引き直す専用パスで、タイル面ではない
    expect(roadSurfaceFor('FC')!.tileGrid).toBeNull();
    expect(sfc.tileGrid).toEqual({ size: 8, maxUniqueTiles: 256 });
  });

  it('SFC のユニークな 8×8 タイルが 256 種以内', () => {
    const image = load(sfc);
    expect(image.width).toBe(sfc.textureWidth);
    expect(image.height).toBe(sfc.textureHeight);
    const { size, maxUniqueTiles } = sfc.tileGrid!;
    expect(uniqueTiles(image, size)).toBeLessThanOrEqual(maxUniqueTiles);
  });

  it('SFC の全画素が RGB555 の格子に載っている', () => {
    const image = load(sfc);
    const offGrid = new Set<string>();
    for (let offset = 0; offset < image.pixels.length; offset += 4) {
      const [r, g, b] = [image.pixels[offset]!, image.pixels[offset + 1]!, image.pixels[offset + 2]!];
      if (r % 8 !== 0 || g % 8 !== 0 || b % 8 !== 0) offGrid.add(`${r},${g},${b}`);
      expect(image.pixels[offset + 3]).toBe(255);
    }
    expect([...offGrid]).toEqual([]);
  });

  it('SFC の V 方向の模様がタイル境界で切り替わる', () => {
    // ここがずれるとタイルの種類が一気に増え、上限 256 に収まらなくなる
    const { size } = sfc.tileGrid!;
    const texelPerMeter = sfc.textureHeight / sfc.periodMeters;
    for (const meters of [sfc.dashMeters, sfc.dashGapMeters, sfc.kerbStripeMeters]) {
      const texels = meters * texelPerMeter;
      expect(Number.isInteger(texels), `${meters} m = ${texels} texel`).toBe(true);
      expect(texels % size, `${meters} m がタイル境界に載っていない`).toBe(0);
    }
    // 破線と縁石の縞が同じ 24 m 周期であること（V を 1 周期ずらせる性質・§3.3）
    expect(patternPeriodMeters(sfc)).toBe(24);
    expect(sfc.periodMeters % patternPeriodMeters(sfc)).toBe(0);
  });

  it('SFC のテクセル密度が Mode 7 の面に収まる', () => {
    // 1024×512（10.7 × 5.3 texel/m）は実機に焼けない情報量だった。
    // 投影に関わる spanMeters / periodMeters は変えず、密度だけを落としている
    expect(sfc.textureWidth / sfc.spanMeters).toBeCloseTo(5.33, 2);
    expect(sfc.textureHeight / sfc.periodMeters).toBeCloseTo(2.67, 2);
    expect(sfc.spanMeters).toBe(96);
    expect(sfc.periodMeters).toBe(96);
  });

  it('第2世代の遠景がタイルあたり 16 色・RGB555 の格子に収まる', () => {
    // 遠景も実機では BG 面に描かれ、8×8 タイル・16 色のパレット割りに従っていた。
    // 同梱の coast.png はタイルあたり 28 色を使うので、規約へ寄せた版を焼いて読む
    const backdrop = backdropFor('SFC')!;
    expect(backdrop.texture).not.toBe(backdrop.source);
    const image = decodePng(readFileSync(join(process.cwd(), 'public', backdrop.texture)));
    expect(image.width).toBe(backdrop.width);
    expect(image.height).toBe(backdrop.height);

    const { size, maxColorsPerTile } = backdrop.tileGrid!;
    let worst = 0;
    for (let tileY = 0; tileY < image.height / size; tileY++) {
      for (let tileX = 0; tileX < image.width / size; tileX++) {
        const colors = new Set<number>();
        for (let y = 0; y < size; y++) {
          for (let x = 0; x < size; x++) {
            const offset = ((tileY * size + y) * image.width + tileX * size + x) * 4;
            expect(image.pixels[offset]! % 8).toBe(0);
            expect(image.pixels[offset + 1]! % 8).toBe(0);
            expect(image.pixels[offset + 2]! % 8).toBe(0);
            colors.add(
              (image.pixels[offset]! << 16) |
                (image.pixels[offset + 1]! << 8) |
                image.pixels[offset + 2]!,
            );
          }
        }
        worst = Math.max(worst, colors.size);
      }
    }
    expect(worst).toBeLessThanOrEqual(maxColorsPerTile);
  });

  it('第1世代の遠景は同梱のまま（2bpp の 4 色までは落とさない）', () => {
    // FC の BG は タイルあたり 4 色。そこまで落とすと絵が成立しないので、
    // 同時 25 色（レンダラーが 54 色へ丸める）の契約だけを守る
    const backdrop = backdropFor('FC')!;
    expect(backdrop.tileGrid).toBeNull();
    expect(backdrop.texture).toBe(backdrop.source);
  });

  it('模様の寸法がテクセル格子に載っている', () => {
    const texelPerMeter = sfc.textureWidth / sfc.spanMeters;
    const widths = [
      sfc.roadHalfWidth,
      sfc.kerbWidth,
      sfc.runoffWidth,
      sfc.wearWidth,
      sfc.lineWidth,
      sfc.edgeLineOffset,
      ...sfc.colors.grass.filter((band) => Number.isFinite(band.width)).map((band) => band.width),
    ];
    for (const meters of widths) {
      expect(Number.isInteger(meters * texelPerMeter), `${meters} m`).toBe(true);
    }
  });
});
