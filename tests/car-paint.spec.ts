import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATION_IDS } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { ENTRANT_COUNT } from '../src/game/sim/state.js';
import { CAR_PAINT, carTextureFor } from '../src/game/view/shared/car-model.js';
import { ENTRANT_COLORS } from '../src/game/view/shared/variants.js';
import { decodePng } from '../tools/lib/png.mjs';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 車体色の作り方を固定する（実装計画 §3.4）。
 *
 * 塗装テクスチャは**無彩色**で、色は `MeshCommand.color` の乗算だけで決まる。
 * この前提が崩れる（テクスチャに色が残る・乗算が白のまま）と、8 台が同じ色になるか
 * 濁った色になる。どちらも例外にならないので、画素と積んだコマンドで確かめる。
 */

function loadPaint(generation: 'PS1' | 'PS2') {
  const paint = CAR_PAINT[generation]!;
  return decodePng(readFileSync(join(process.cwd(), 'public', paint.texture)));
}

function parseHex(hex: string) {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff] as const;
}

function rgbToHsv(r: number, g: number, b: number) {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta + 6) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
  }
  return { h: hue, s: max === 0 ? 0 : delta / max, v: max };
}

function hueDistance(a: number, b: number) {
  const delta = Math.abs(a - b) % 1;
  return Math.min(delta, 1 - delta);
}

describe('車体の塗装', () => {
  it('塗装テクスチャが完全な無彩色である', () => {
    for (const generation of ['PS1', 'PS2'] as const) {
      const image = loadPaint(generation);
      expect(image.width).toBe(CAR_PAINT[generation]!.size);
      // 少しでも色が残っていると、乗算した車体色が濁る。
      // 画素ごとに expect を呼ぶと 30 万回になるので、走査は素の JS で行う
      let colored = 0;
      for (let index = 0; index < image.pixels.length; index += 4) {
        if (
          image.pixels[index] !== image.pixels[index + 1] ||
          image.pixels[index] !== image.pixels[index + 2]
        ) {
          colored += 1;
        }
      }
      expect(colored, `${generation}: 色の残った画素がある`).toBe(0);
    }
  });

  it('塗装部が十分に明るく、色を掛けたときに沈まない', () => {
    const image = loadPaint('PS1');
    const levels: number[] = [];
    for (let index = 0; index < image.pixels.length; index += 4) {
      if (image.pixels[index + 3]! < 8) continue;
      levels.push(image.pixels[index]!);
    }
    levels.sort((a, b) => a - b);
    // 上位 25% が明るくないと、色を掛けた車体が暗く沈む
    const upperQuartile = levels[Math.floor(levels.length * 0.75)]!;
    expect(upperQuartile).toBeGreaterThan(150);
    // 一方で全面が白飛びしていると陰影が消える
    expect(levels[Math.floor(levels.length * 0.5)]!).toBeLessThan(230);
  });

  it('乗算した結果がエントラント色の色相と一致する', () => {
    const image = loadPaint('PS1');
    // 塗装部（明るい画素）だけを見て、色を掛けた結果の色相を測る
    for (let entrant = 0; entrant < ENTRANT_COUNT; entrant++) {
      const [tr, tg, tb] = parseHex(ENTRANT_COLORS[entrant]!);
      const target = rgbToHsv(tr / 255, tg / 255, tb / 255);

      let x = 0;
      let y = 0;
      let count = 0;
      for (let index = 0; index < image.pixels.length; index += 4) {
        const level = image.pixels[index]! / 255;
        if (level < 0.5) continue;
        const { h, s } = rgbToHsv((level * tr) / 255, (level * tg) / 255, (level * tb) / 255);
        if (s < 0.2) continue;
        x += Math.cos(h * Math.PI * 2);
        y += Math.sin(h * Math.PI * 2);
        count += 1;
      }
      expect(count).toBeGreaterThan(100);
      const hue = (Math.atan2(y / count, x / count) / (Math.PI * 2) + 1) % 1;
      expect(hueDistance(hue, target.h), `#${entrant} の色相がずれている`).toBeLessThan(0.01);
    }
  });

  it('エントラント色どうしの色相が離れている', () => {
    const hues = ENTRANT_COLORS.map((color) => {
      const [r, g, b] = parseHex(color);
      return rgbToHsv(r / 255, g / 255, b / 255).h;
    });
    for (let a = 0; a < hues.length; a++) {
      for (let b = a + 1; b < hues.length; b++) {
        expect(
          hueDistance(hues[a]!, hues[b]!),
          `${ENTRANT_COLORS[a]} と ${ENTRANT_COLORS[b]} が近すぎる`,
        ).toBeGreaterThan(0.03);
      }
    }
  });

  it('ビューは 1 枚のテクスチャを共有し、色だけを台ごとに変える', () => {
    const frame = buildFrame('PS1', raceAfter(1500));
    const carMeshes = frame.meshes.filter((mesh) => mesh.id.startsWith('car-'));
    expect(carMeshes).toHaveLength(ENTRANT_COUNT);

    // マテリアルは 1 つ。テクスチャを 8 枚焼く必要が無いのがこの方式の要点
    const materialIds = new Set(carMeshes.map((mesh) => mesh.material));
    expect(materialIds.size).toBe(1);

    const colors = carMeshes.map((mesh) => mesh.color);
    expect(new Set(colors).size).toBe(ENTRANT_COUNT);
    for (const color of colors) {
      expect(ENTRANT_COLORS).toContain(color);
      // 白のままだと全車が同じ見た目になる
      expect(color).not.toBe('#ffffff');
    }
  });

  it('塗装テクスチャを持たない世代は素の base color へ落ちる', () => {
    for (const generation of GENERATION_IDS) {
      if (CAR_PAINT[generation]) continue;
      expect(carTextureFor(generation)).toBe('');
    }
    expect(carTextureFor('PS1')).toBe('assets/gen3/textures/car_paint.png');
    expect(carTextureFor('PS2')).toBe('assets/gen4/textures/car_paint.png');
  });
});
