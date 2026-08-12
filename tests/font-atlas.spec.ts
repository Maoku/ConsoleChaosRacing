import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { FONT_ATLAS, LOGO_ATLAS, fontCell, measureText } from '../src/game/view/shared/font.js';
import { decodePng } from '../tools/lib/png.mjs';

/**
 * 生成した HUD フォントとタイトルロゴの向きと形を固定する（実装計画 §3.5 / §3.7）。
 *
 * **上下の向きが最も間違えやすい。** レンダラーはアトラスを `flipY: false` で取り込み、
 * スクリーン空間スプライトのクアッドは**画像の上端をスプライトの下端へ**割り当てる。
 * つまり字形はセルの中で上下反転して焼くのが正しく、素直に置くと文字が逆さまに出る。
 * 例外にはならないので、画面を見るまで気付けない（車スプライトと同じ事情）。
 *
 * あわせて**半端な α を 1 画素も作らない**ことを固定する。FC は `translucency: none` で、
 * スプライト面が `a ≥ 0.5` のしきい値で合成されるため、中間の α は世代によって
 * 縁の出方が変わってしまう。
 */

const { columns, rows, cell, glyphWidth, glyphHeight, firstCharCode } = FONT_ATLAS;

function load(url: string) {
  return decodePng(readFileSync(join(process.cwd(), 'public', url)));
}

const font = load(FONT_ATLAS.url);

/** セル内の座標（左上原点・字形の座標系）で α を引く */
function alphaAt(charCode: number, glyphX: number, glyphY: number): number {
  const index = fontCell(charCode)!;
  const x = (index % columns) * cell + glyphX;
  // 焼くときにセルの中で上下反転しているので、読むときも同じ変換で戻す
  const y = Math.floor(index / columns) * cell + (cell - 1 - glyphY);
  return font.pixels[(y * font.width + x) * 4 + 3]!;
}

function inkedPixels(charCode: number): number {
  let inked = 0;
  for (let y = 0; y < cell; y++) {
    for (let x = 0; x < cell; x++) {
      if (alphaAt(charCode, x, y) > 0) inked += 1;
    }
  }
  return inked;
}

function glyphRows(charCode: number): string[] {
  const lines: string[] = [];
  for (let y = 0; y < glyphHeight; y++) {
    let line = '';
    for (let x = 0; x < glyphWidth; x++) line += alphaAt(charCode, x, y) > 0 ? '#' : '.';
    lines.push(line);
  }
  return lines;
}

describe('HUD フォントアトラス', () => {
  it('寸法が FONT_ATLAS と一致する', () => {
    expect(font.width).toBe(columns * cell);
    expect(font.height).toBe(rows * cell);
    expect(columns * rows).toBe(96);
    expect(firstCharCode).toBe(0x20);
  });

  it('画素は完全な透明か不透明な白のどちらかしかない', () => {
    const seen = new Set<string>();
    for (let index = 0; index < font.width * font.height; index++) {
      const [r, g, b, a] = font.pixels.subarray(index * 4, index * 4 + 4);
      seen.add(a === 0 ? 'clear' : `${r},${g},${b},${a}`);
    }
    expect([...seen].sort()).toEqual(['255,255,255,255', 'clear']);
  });

  it('字形はセルの左上 5×7 に収まる（字送り 6 px が隣を消さない根拠）', () => {
    for (let index = 0; index < columns * rows; index++) {
      const charCode = firstCharCode + index;
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          if (x < glyphWidth && y < glyphHeight) continue;
          expect(alphaAt(charCode, x, y), `0x${charCode.toString(16)} の (${x}, ${y})`).toBe(0);
        }
      }
    }
  });

  it('上下の向きが正しい（"1" の足が下・"T" の横棒が上）', () => {
    // 逆さまに焼くと 2 つとも上下が入れ替わる。1 文字だけでは対称な字形に騙される
    expect(glyphRows('1'.charCodeAt(0)).at(-1)).toBe('.###.');
    expect(glyphRows('T'.charCodeAt(0))[0]).toBe('#####');
    expect(glyphRows('T'.charCodeAt(0)).at(-1)).toBe('..#..');
  });

  it('空白は空で、英数字はすべて点灯している', () => {
    expect(inkedPixels(' '.charCodeAt(0))).toBe(0);
    for (const text of ['0123456789', 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', ':./-']) {
      for (const character of text) {
        expect(inkedPixels(character.charCodeAt(0)), character).toBeGreaterThan(0);
      }
    }
  });

  it('小文字のセルには大文字と同じ字形が焼かれている', () => {
    // 当時の HUD フォントの作法。実行時に大文字へ畳む処理を持たなくて済む
    for (let code = 0x61; code <= 0x7a; code++) {
      expect(glyphRows(code), String.fromCharCode(code)).toEqual(glyphRows(code - 0x20));
    }
  });

  it('0x7F は塗りつぶしのセル（HUD のパネルと帯に使う）', () => {
    expect(glyphRows(0x7f)).toEqual(Array.from({ length: glyphHeight }, () => '#####'));
  });

  it('セル番号の範囲外は null を返す', () => {
    expect(fontCell(0x1f)).toBeNull();
    expect(fontCell(0x80)).toBeNull();
    expect(fontCell(0x20)).toBe(0);
    expect(fontCell(0x7f)).toBe(95);
  });

  it('measureText が字送りと一致する（最後の隙間は含めない）', () => {
    expect(measureText('')).toBe(0);
    expect(measureText('A')).toBe(glyphWidth);
    expect(measureText('AB')).toBe(FONT_ATLAS.advance + glyphWidth);
    expect(measureText('AB', 2)).toBe((FONT_ATLAS.advance + glyphWidth) * 2);
  });
});

describe('タイトルロゴ', () => {
  const logo = load(LOGO_ATLAS.url);

  it('寸法が LOGO_ATLAS と一致する', () => {
    expect(logo.width).toBe(LOGO_ATLAS.width);
    expect(logo.height).toBe(LOGO_ATLAS.height);
  });

  it('半端な α が 1 画素も無い（FC のしきい値合成で縁が変わらない）', () => {
    for (let index = 0; index < logo.width * logo.height; index++) {
      const alpha = logo.pixels[index * 4 + 3]!;
      expect(alpha === 0 || alpha === 255, `α=${alpha}`).toBe(true);
    }
  });

  it('色数が FC の同時 25 色の予算に収まる', () => {
    // 4 世代で 1 枚を共用するので、いちばん厳しい世代に合わせて焼く（§6.1 第1世代基準 1）
    const colors = new Set<string>();
    for (let index = 0; index < logo.width * logo.height; index++) {
      const [r, g, b, a] = logo.pixels.subarray(index * 4, index * 4 + 4);
      if (a !== 0) colors.add(`${r},${g},${b}`);
    }
    expect(colors.size).toBeLessThanOrEqual(25);
    expect(colors.size).toBeGreaterThan(1);
  });

  it('絵が縦方向に偏っていない（上下反転して焼かれた形跡の検出）', () => {
    // ロゴは上に小さな行・下に大きな行という構図なので、
    // **下半分のほうが点灯画素が多い**。逆さまに焼くとこれが反転する。
    // 画像は flipY:false 前提で反転済みなので、画像上での上半分が画面での下半分にあたる
    const half = logo.height / 2;
    let imageTop = 0;
    let imageBottom = 0;
    for (let y = 0; y < logo.height; y++) {
      for (let x = 0; x < logo.width; x++) {
        if (logo.pixels[(y * logo.width + x) * 4 + 3] === 0) continue;
        if (y < half) imageTop += 1;
        else imageBottom += 1;
      }
    }
    expect(imageTop).toBeGreaterThan(imageBottom);
  });
});
