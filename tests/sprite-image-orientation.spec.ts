import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATION_IDS, writeSpriteModelMatrix } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import { COCKPIT_ATLAS, WHEEL_ATLAS } from '../src/game/view/shared/cockpit.js';
import { FONT_ATLAS, fontCell } from '../src/game/view/shared/font.js';
import { MINIMAP_LAYOUTS, minimapPoint, minimapProjection, textureRect } from '../src/game/view/shared/minimap-layout.js';
import { TACHO_ATLAS, TACHOMETERS } from '../src/game/view/shared/tachometer.js';
import { decodePng } from '../tools/lib/png.mjs';

const load = (url: string) => decodePng(readFileSync(join(process.cwd(), 'public', url)));

describe('同梱Engineと非対称スプライト画像の向き', () => {
  it('画像上端をscreenSpaceの上端へ貼り、Pの横棒を上・縦棒を下に描く', () => {
    const font = load(FONT_ATLAS.url);
    const cell = fontCell('P'.charCodeAt(0))!;
    const left = (cell % FONT_ATLAS.columns) * FONT_ATLAS.cell;
    const top = Math.floor(cell / FONT_ATLAS.columns) * FONT_ATLAS.cell;
    const rows = Array.from({ length: 8 }, (_unused, y) =>
      Array.from({ length: 5 }, (_unusedX, x) =>
        font.pixels[((top + y) * font.width + left + x) * 4 + 3] > 0 ? '#' : '.',
      ).join(''),
    );
    // 生成ツールの反転をテストで戻さず、PNGそのものの非対称字形を検査する。
    expect(rows).toEqual(['####.', '#...#', '#...#', '####.', '#....', '#....', '#....', '.....']);
    const matrix = writeSpriteModelMatrix(new Float32Array(16), {
      id: 'glyph-P', position: [4, 4, 0], size: [8, 8], color: '#ffffff', screenSpace: true,
    }, [0, 0, 1]);
    // billboardMeshは画像上端v0をlocal y=+1へ貼る。Y-down画面ではy=0が上端。
    expect(matrix[13]! + matrix[5]!).toBe(0);
    expect(matrix[13]! - matrix[5]!).toBe(8);
  });

  for (const [index, generation] of GENERATION_IDS.entries()) {
    it(`${generation}: ミニマップのコース線がマーカーと同じY-down座標にある`, () => {
      const layout = MINIMAP_LAYOUTS[generation];
      const image = load(`assets/gen${index + 1}/hud/minimap.png`);
      const projection = minimapProjection(TRACK.bounds, textureRect(layout.size), layout.margin);
      const matches = (flipped: boolean) => TRACK.samples.filter((_sample, sampleIndex) => sampleIndex % 37 === 0)
        .filter((sample) => {
          const [px, py] = minimapPoint(projection, sample.position[0], sample.position[2]);
          const x = Math.round(px);
          const y = flipped ? image.height - 1 - Math.round(py) : Math.round(py);
          // アンチエイリアスを含め、投影点の近傍に実際の線の色があることを確認する。
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
            if (x + dx < 0 || x + dx >= image.width || y + dy < 0 || y + dy >= image.height) continue;
            const offset = ((y + dy) * image.width + x + dx) * 4;
            if (image.pixels[offset + 3] > 0 && layout.lineColor.every((channel, c) =>
              Math.abs(image.pixels[offset + c] - channel) <= 20,
            )) return true;
          }
          return false;
        }).length;
      const samples = TRACK.samples.filter((_sample, sampleIndex) => sampleIndex % 37 === 0).length;
      expect(matches(false) / samples).toBeGreaterThan(0.95);
      expect(matches(false) - matches(true)).toBeGreaterThan(samples * 0.25);
    });
  }

  for (const generation of ['PS1', 'PS2'] as const) {
    it(`${generation}: タコメーターの針セルは上向きで、セル番号が変わらない`, () => {
      const layout = TACHOMETERS[generation]!;
      const image = load(layout.url);
      const size = layout.cellSize;
      const cell = TACHO_ATLAS.cells.needle;
      const originX = (cell % TACHO_ATLAS.columns) * size;
      const originY = Math.floor(cell / TACHO_ATLAS.columns) * size;
      const alpha = (fraction: number) => image.pixels[
        ((originY + Math.round(size * fraction)) * image.width + originX + Math.floor(size / 2)) * 4 + 3
      ];
      expect(alpha(0.2)).toBeGreaterThan(0);
      expect(alpha(0.8)).toBe(0);
    });
  }

  it('コックピットは上側が窓、下側がダッシュボードで、スポークは下を向く', () => {
    const interior = load(COCKPIT_ATLAS.url);
    const alpha = (fraction: number) => interior.pixels[
      (Math.round(interior.height * fraction) * interior.width + Math.floor(interior.width / 2)) * 4 + 3
    ];
    expect(alpha(0.2)).toBe(0);
    expect(alpha(0.8)).toBe(255);
    const wheel = load(WHEEL_ATLAS.url);
    const centerAlpha = (fraction: number) => wheel.pixels[
      (Math.round(wheel.height * fraction) * wheel.width + Math.floor(wheel.width / 2)) * 4 + 3
    ];
    expect(centerAlpha(0.25)).toBe(0);
    expect(centerAlpha(0.75)).toBe(255);
  });
});
