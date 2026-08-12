import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAR_SPRITE_GEOMETRY,
  CAR_SPRITE_SOURCES,
} from '../src/game/view/shared/car-sprite.js';
import { decodePng } from '../tools/lib/png.mjs';

/**
 * 整形済みアトラスの向きと配置を固定する（実装計画 §3.2）。
 *
 * **上下の向きが最も間違えやすい。** レンダラーはアトラスを `flipY: false` で取り込み、
 * スクリーン空間スプライトのクアッドは**画像の上端をスプライトの下端へ**割り当てる
 * （`render/geometry` のセル UV と、`screenSpace` の `ortho(0, W, H, 0)` の組み合わせ）。
 * つまりアトラスは**上下を反転して焼く**のが正しく、素直に置くと車が逆さまに描かれる。
 * これは例外にならず、テクスチャが読めていないわけでもないので、画面を見るまで気付けない。
 *
 * ミニマップの俯瞰図（`build-minimap.mjs`）が `flipVertical()` しているのと同じ理由。
 */

const { columns, rows, cell, groundFraction, heightFraction } = CAR_SPRITE_GEOMETRY;
/** 描画されたスプライトの上端から見た接地線の行 */
const GROUND_ROW = Math.round(groundFraction * cell);
const OPAQUE = 8;

function loadAtlas(url: string) {
  const image = decodePng(readFileSync(join(process.cwd(), 'public', url)));
  return {
    image,
    /** セル (column, row) のなかで不透明な画素がある行の範囲（画像の座標系） */
    extent(column: number, row: number): [number, number] {
      let first = -1;
      let last = -1;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = column * cell + x;
          const py = row * cell + y;
          if (image.pixels[(py * image.width + px) * 4 + 3]! >= OPAQUE) {
            if (first < 0) first = y;
            last = y;
            break;
          }
        }
      }
      return [first, last];
    },
  };
}

describe('車スプライトのアトラス', () => {
  for (const source of CAR_SPRITE_SOURCES) {
    describe(source.to, () => {
      const atlas = loadAtlas(source.to);

      it('セルの升目どおりの大きさで焼かれている', () => {
        expect(atlas.image.width).toBe(cell * columns);
        expect(atlas.image.height).toBe(cell * rows);
      });

      it('絵が上下反転して置かれている（描画時に正立する）', () => {
        for (let row = 0; row < rows; row++) {
          for (let column = 0; column < columns; column++) {
            const [first, last] = atlas.extent(column, row);
            expect(first, `セル(${column}, ${row})が空`).toBeGreaterThanOrEqual(0);
            // 反転して置いてあるので、接地線は**画像の上側**に来る。
            // 反転を忘れると絵が下側（cell - GROUND_ROW より下）へ寄る
            expect(first, `セル(${column}, ${row})の接地線`).toBe(cell - GROUND_ROW);
            expect(last).toBeLessThan(cell - GROUND_ROW + heightFraction * cell);
          }
        }
      });

      it('3 列とも接地線が揃っている（傾けても車が浮き沈みしない）', () => {
        // 元絵は車ごとに 1 px ずれていることがある（第2世代の正面がそう）。
        // 高さは揃わなくてよいが、接地線＝反転後の上端は必ず一致すること
        for (let row = 0; row < rows; row++) {
          const grounds = Array.from(
            { length: columns },
            (_unused, column) => atlas.extent(column, row)[0],
          );
          for (const ground of grounds) expect(ground).toBe(grounds[0]);
        }
      });

      it('絵がセルの境界をはみ出していない（隣の車が写り込まない）', () => {
        // 整形前の cars.png はここで落ちる。左傾きの車が右隣のセルへ 2 px 出ていた
        for (let column = 1; column < columns; column++) {
          const boundary = column * cell;
          for (let y = 0; y < atlas.image.height; y++) {
            const left = (y * atlas.image.width + boundary - 1) * 4 + 3;
            const right = (y * atlas.image.width + boundary) * 4 + 3;
            expect(
              atlas.image.pixels[left]! < OPAQUE || atlas.image.pixels[right]! < OPAQUE,
              `行 ${y} でセル境界 ${boundary} が繋がっている`,
            ).toBe(true);
          }
        }
      });
    });
  }
});
