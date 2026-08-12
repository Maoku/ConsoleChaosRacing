import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATION_IDS } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { ENTRANT_COUNT } from '../src/game/sim/state.js';
import {
  CAR_LIVERIES,
  carLiveryTexture,
  carTextureFor,
} from '../src/game/view/shared/car-model.js';
import { ENTRANT_COLORS } from '../src/game/view/shared/variants.js';
import { decodePng } from '../tools/lib/png.mjs';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * エントラントごとの塗り分け（リバリー）を固定する。
 *
 * 車テクスチャには赤いリバリーが焼き込まれているので、`MeshCommand.color` の乗算では
 * 8 台を見分けられない。テクスチャそのものを塗り替えているため、
 * 「本当に色が分かれているか」は画素を数えて確かめるしかない。
 */

function loadLivery(generation: 'PS1', entrant: number) {
  const url = carLiveryTexture(generation, entrant);
  expect(url).toBeTruthy();
  return decodePng(readFileSync(join(process.cwd(), 'public', url!)));
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

/** 彩度のある画素の平均色相。車体色そのもの */
function dominantHue(image: { pixels: Buffer }) {
  let x = 0;
  let y = 0;
  let count = 0;
  for (let index = 0; index < image.pixels.length; index += 4) {
    const { h, s } = rgbToHsv(
      image.pixels[index]! / 255,
      image.pixels[index + 1]! / 255,
      image.pixels[index + 2]! / 255,
    );
    if (s < 0.35) continue;
    // 色相は円環なので、単純平均ではなくベクトルの平均を取る
    x += Math.cos(h * Math.PI * 2);
    y += Math.sin(h * Math.PI * 2);
    count += 1;
  }
  expect(count).toBeGreaterThan(500);
  const hue = Math.atan2(y / count, x / count) / (Math.PI * 2);
  return (hue + 1) % 1;
}

function hueDistance(a: number, b: number) {
  const delta = Math.abs(a - b) % 1;
  return Math.min(delta, 1 - delta);
}

describe('車のリバリー', () => {
  it('出走台数ぶんのリバリーがある', () => {
    const livery = CAR_LIVERIES.PS1;
    expect(livery).not.toBeNull();
    expect(livery!.count).toBe(ENTRANT_COUNT);
  });

  it('8 枚がそれぞれ違う色相で、エントラント色と一致する', () => {
    const hues: number[] = [];
    for (let entrant = 0; entrant < ENTRANT_COUNT; entrant++) {
      const image = loadLivery('PS1', entrant);
      expect(image.width).toBe(CAR_LIVERIES.PS1!.size);

      const hue = dominantHue(image);
      hues.push(hue);

      // 意図した色（ENTRANT_COLORS）の色相に寄っている
      const target = Number.parseInt(ENTRANT_COLORS[entrant]!.slice(1), 16);
      const expected = rgbToHsv(
        ((target >> 16) & 0xff) / 255,
        ((target >> 8) & 0xff) / 255,
        (target & 0xff) / 255,
      ).h;
      expect(
        hueDistance(hue, expected),
        `#${entrant} の色相が ${ENTRANT_COLORS[entrant]} から離れている`,
      ).toBeLessThan(0.06);
    }

    // どの 2 台も色相が十分に離れている（320×240 で見分けられる距離）
    for (let a = 0; a < hues.length; a++) {
      for (let b = a + 1; b < hues.length; b++) {
        expect(
          hueDistance(hues[a]!, hues[b]!),
          `#${a} と #${b} の色相が近すぎる`,
        ).toBeGreaterThan(0.03);
      }
    }
  });

  it('タイヤ・窓などの無彩色は塗り替えていない', () => {
    const first = loadLivery('PS1', 0);
    const second = loadLivery('PS1', 5);
    let neutral = 0;
    let identical = 0;
    for (let index = 0; index < first.pixels.length; index += 4) {
      const { s } = rgbToHsv(
        first.pixels[index]! / 255,
        first.pixels[index + 1]! / 255,
        first.pixels[index + 2]! / 255,
      );
      if (s > 0.1) continue;
      neutral += 1;
      if (
        first.pixels[index] === second.pixels[index] &&
        first.pixels[index + 1] === second.pixels[index + 1] &&
        first.pixels[index + 2] === second.pixels[index + 2]
      ) {
        identical += 1;
      }
    }
    expect(neutral).toBeGreaterThan(1000);
    expect(identical / neutral).toBeGreaterThan(0.99);
  });

  it('ビューが 8 台ぶんの別マテリアルを積み、テクスチャが重複しない', () => {
    const frame = buildFrame('PS1', raceAfter(1500));
    const carMeshes = frame.meshes.filter((mesh) => mesh.id.startsWith('car-'));
    expect(carMeshes).toHaveLength(ENTRANT_COUNT);

    const materials = new Map(frame.materials.map((material) => [material.id, material]));
    const textures = new Set<string>();
    for (const mesh of carMeshes) {
      const material = materials.get(mesh.material!)!;
      expect(material).toBeDefined();
      textures.add(material.baseColorTexture!);
      // 塗り分けはテクスチャ側。乗算で濁らせない
      expect(mesh.color).toBe('#ffffff');
    }
    expect(textures.size).toBe(ENTRANT_COUNT);
  });

  it('リバリーを持たない世代は素の base color へ落ちる', () => {
    for (const generation of GENERATION_IDS) {
      if (CAR_LIVERIES[generation]) continue;
      expect(carLiveryTexture(generation, 3)).toBeNull();
    }
    expect(carTextureFor('PS2', 3)).toBe('assets/gen4/textures/car_base_color.png');
    expect(carTextureFor('PS1', 3)).toBe('assets/gen3/textures/car_livery_3.png');
    // 台数を超えた番号は巻き戻る（将来 8 台以外にしたときの保険）
    expect(carTextureFor('PS1', ENTRANT_COUNT + 2)).toBe(carTextureFor('PS1', 2));
  });
});
