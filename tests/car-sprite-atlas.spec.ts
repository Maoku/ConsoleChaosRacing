import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  CAR_SPRITE_GEOMETRY,
  CAR_SPRITE_SOURCES,
  STEER_FRAME,
  steerCellOffset,
} from '../src/game/view/shared/car-sprite.js';
import type { DisplayCar } from '../src/game/view/shared/display-state.js';
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
const THRESHOLDS = STEER_FRAME.FC;
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

function car(values: Partial<DisplayCar>): DisplayCar {
  return {
    entrant: 0,
    s: 0,
    lateral: 0,
    yaw: 0,
    speed: 50,
    standing: 1,
    lap: 1,
    offTrack: false,
    lateralAccel: 0,
    longitudinalAccel: 0,
    lapStartTick: 0,
    bestLapTicks: -1,
    finished: false,
    ...values,
  };
}

/**
 * どの列がどちら向きかを、**絵そのものから**決める。
 *
 * 列 0 の絵はノーズが画面の右奥を向き、見えている側面が車の右側になっている。
 * 追走カメラから右側面が見えるのは車が右へ向きを変えたときなので、列 0 が右コーナー。
 * ここを取り違えると、コーナーで車が逆へ傾いた絵になる（例外にはならない）。
 *
 * 絵の側で確かめられる特徴として**テールランプの位置**を使う。車体の色に関わらず
 * 赤く光っている画素はテールランプだけなので、その重心がそのまま「車の後ろが
 * セルのどちら寄りに写っているか」になる。後ろが左に寄っていれば、ノーズは右。
 *
 * 自機の行（黄色）で測る。ライバルの行は車体が赤くランプと見分けが付かないが、
 * 元絵の列は 2 行で共通なので片方を確かめれば足りる。
 */
function rearDirection(image: ReturnType<typeof decodePng>, column: number): number {
  const { cell } = CAR_SPRITE_GEOMETRY;
  const left = column * cell;
  let weighted = 0;
  let total = 0;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      const index = (y * image.width + left + x) * 4;
      const [red, green, blue, alpha] = image.pixels.subarray(index, index + 4);
      if (alpha! < OPAQUE) continue;
      if (red! < 110 || red! < green! * 2 || red! < blue! * 2) continue;
      weighted += x - cell / 2;
      total += 1;
    }
  }
  expect(total, `列 ${column} にテールランプが見つからない`).toBeGreaterThan(20);
  return weighted / total;
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

      it('列 0 は車の後ろが左に写る（＝ノーズが右／右コーナー）', () => {
        const rear = [0, 1, 2].map((column) => rearDirection(atlas.image, column));
        expect(rear[0]!, '列 0 のノーズが右を向いていない').toBeLessThan(-8);
        expect(Math.abs(rear[1]!), '列 1 は正面のはず').toBeLessThan(4);
        expect(rear[2]!, '列 2 のノーズが左を向いていない').toBeGreaterThan(8);
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

  describe('傾きのセル選び', () => {
    // 曲率を門にした AND ゲート（8-1）そのものは `car-sprite.spec.ts` が実コースの
    // 区間で固定する。ここで見るのは**絵とセル番号の対応**だけ — 上の
    // 「列 0 は車の後ろが左に写る」の検査と、この向きの選び方が食い違わないこと
    const CORNER = 1 / 60;

    it('右コーナーで列 0、左コーナーで列 2 を選ぶ', () => {
      // 列 0 はノーズが右を向いた絵（上のテストで固定してある）。
      // 横加速度が右向き（正）＝右コーナーなので、選ぶのは列 0
      expect(steerCellOffset(car({ lateralAccel: 8 }), CORNER, THRESHOLDS)).toBe(0);
      expect(steerCellOffset(car({ lateralAccel: -8 }), CORNER, THRESHOLDS)).toBe(2);
      expect(steerCellOffset(car({ lateralAccel: 0 }), CORNER, THRESHOLDS)).toBe(1);
    });

    it('コーナーの最中はずっと傾いた絵になる', () => {
      // 曲がれている間はコース接線に対するヨー角がほぼ 0 になる。
      // ヨー角で判定すると絵がコーナーの途中で正面へ戻ってしまう
      expect(steerCellOffset(car({ yaw: 0, lateralAccel: 9 }), CORNER, THRESHOLDS)).toBe(0);
    });

    it('直進では舵を当てていても正面のまま', () => {
      expect(steerCellOffset(car({ lateralAccel: 1.2 }), CORNER, THRESHOLDS)).toBe(1);
      expect(steerCellOffset(car({ lateralAccel: -1.2 }), CORNER, THRESHOLDS)).toBe(1);
    });
  });
});
