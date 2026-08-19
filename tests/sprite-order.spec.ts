import {
  HARDWARE_GENERATION_PROFILES,
  NO_ENTITY,
  applyScanlineLimit,
  createRenderFrame,
  type GenerationId,
  type SpriteCommand,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { createRaceState } from '../src/game/sim/state.js';
import { CAR_SPRITE_GEOMETRY } from '../src/game/view/shared/car-sprite.js';
import { pushSpritePlane, type SpriteEntry } from '../src/game/view/shared/sprite-plane.js';
import { buildFrame } from './support/frame.js';

/**
 * 車スプライトの重ね順（実装計画 11-2 / R-2）。
 *
 * 擬似3D の 2 世代は、**画面の下にある車ほど手前**に描かれなければならない。
 * 以前は「登録順の逆」に積んでおり、`rivalPlacements()` が遠い順に返すため
 * 遠い車が手前に出ていた（FC で 7.5 %・SFC で 16.0 % のフレーム）。
 * 自機は必ず先頭に登録されるので、自機より手前のライバルも自機の後ろに隠れていた。
 *
 * ここで固定するのは 3 つ。
 *
 * 1. 車スプライトの並びが**接地線 Y の昇順**であること（自機も同じ 1 本の並び）
 * 2. §2.2 で数えた「重ね順が Y と逆」のフレームが **0 件**になること
 * 3. 走査線制限の対象と優先度は従来どおりで、**落ちる件数が増えない**こと
 */

const GENERATIONS = ['FC', 'SFC'] as const satisfies readonly GenerationId[];
/** §2.2 と同じ走査（6 ティックごと・完走まで） */
const SAMPLE_STRIDE = 6;

function carSprites(sprites: readonly SpriteCommand[], generation: GenerationId) {
  const prefix = `car-sprite-${generation}-`;
  return sprites
    .map((sprite, order) => ({ sprite, order }))
    .filter((entry) => entry.sprite.id.startsWith(prefix))
    .map((entry) => ({
      order: entry.order,
      entrant: Number(entry.sprite.id.slice(prefix.length)),
      // スプライトの position は**セルの中心**。セルの下 14 % は透明なので、
      // 接地線は下端ではなく `groundFraction` の位置にある
      ground:
        entry.sprite.position[1] +
        (CAR_SPRITE_GEOMETRY[generation]!.groundFraction - 0.5) * entry.sprite.size[1],
    }));
}

/** 完走までのフレームを走査し、車スプライトの重ね順を検査する */
function scanRace(generation: GenerationId) {
  const profile = HARDWARE_GENERATION_PROFILES[generation];
  const state = createRaceState({ seed: 20260812, autoPilot: true });
  let frames = 0;
  let overlapping = 0;
  let inverted = 0;
  let worstGap = 0;

  while (state.phase !== 'finished' && state.tick < 60 * 400) {
    for (let step = 0; step < SAMPLE_STRIDE; step++) stepRace(state);
    const frame = buildFrame(generation, state);
    const cars = carSprites(frame.sprites, generation);
    frames += 1;

    // 「重なっている」＝ 画面上で矩形が交差している 2 台があるフレーム
    const boxes = frame.sprites
      .filter((sprite) => sprite.id.startsWith(`car-sprite-${generation}-`))
      .map((sprite) => ({
        left: sprite.position[0] - sprite.size[0] / 2,
        right: sprite.position[0] + sprite.size[0] / 2,
        top: sprite.position[1] - sprite.size[1] / 2,
        bottom: sprite.position[1] + sprite.size[1] / 2,
      }));
    let overlaps = false;
    for (let a = 0; a < boxes.length && !overlaps; a++) {
      for (let b = a + 1; b < boxes.length && !overlaps; b++) {
        const x = boxes[a]!.left < boxes[b]!.right && boxes[b]!.left < boxes[a]!.right;
        const y = boxes[a]!.top < boxes[b]!.bottom && boxes[b]!.top < boxes[a]!.bottom;
        overlaps = x && y;
      }
    }
    if (overlaps) overlapping += 1;

    let broken = false;
    for (let index = 1; index < cars.length; index++) {
      const gap = cars[index - 1]!.ground - cars[index]!.ground;
      if (gap > 1e-6) {
        broken = true;
        worstGap = Math.max(worstGap, gap);
      }
    }
    if (broken && overlaps) inverted += 1;
    expect(profile.video.spritesPerScanline).toBeGreaterThan(0);
  }

  return { frames, overlapping, inverted, worstGap };
}

describe('スプライトの重ね順', () => {
  for (const generation of GENERATIONS) {
    describe(generation, () => {
      const result = scanRace(generation);

      it('車が重なるフレームが実在する（検査が空振りしていない）', () => {
        expect(result.frames).toBeGreaterThan(1000);
        expect(result.overlapping).toBeGreaterThan(100);
      });

      it('重ね順が接地線 Y と逆になるフレームが 1 つも無い', () => {
        expect(result.inverted, `最大の食い違い ${result.worstGap.toFixed(1)} px`).toBe(0);
      });
    });
  }

  /** 制限の対象と優先度は登録順のまま。積む順だけが Y になる */
  function entry(entity: number, y: number, height: number, id: string): SpriteEntry {
    return {
      entity,
      y,
      height,
      sprites: [
        {
          id,
          screenSpace: true,
          position: [0, y + height / 2, 0],
          size: [8, height],
          color: '#ffffff',
          texture: 'x.png',
          generations: ['FC'],
        },
      ],
    };
  }

  describe('走査線制限', () => {
    it('登録順で掛かる（先に登録したものが残る）', () => {
      const profile = HARDWARE_GENERATION_PROFILES.FC;
      const entries = Array.from({ length: profile.video.spritesPerScanline + 4 }, (_x, index) =>
        entry(index, 40, 8, `sprite-${index}`),
      );
      const limited = applyScanlineLimit(
        entries,
        profile.video.spritesPerScanline,
        profile.video.internalHeight,
      );
      expect(limited.visible.length).toBe(profile.video.spritesPerScanline);
      expect(limited.culled.length).toBe(4);
      // 落ちるのは後に登録したものだけ
      for (const culled of limited.culled) {
        expect(culled).toBeGreaterThanOrEqual(profile.video.spritesPerScanline);
      }
    });

    it('積む順は接地線 Y の昇順で、Y を持たない記号は最前面に残る', () => {
      const frame = createRenderFrame();
      const marker: SpriteEntry = { ...entry(NO_ENTITY, 10, 4, 'marker'), depthSorted: false };
      pushSpritePlane(frame, {
        profile: HARDWARE_GENERATION_PROFILES.SFC,
        entries: [entry(0, 100, 20, 'near'), marker, entry(1, 60, 10, 'far')],
      });
      expect(frame.sprites.map((sprite) => sprite.id)).toEqual(['far', 'near', 'marker']);
    });
  });

  it('混雑しても車は落ちず、先に落ちるのは背景オブジェクト（優先度は従来どおり）', () => {
    // 同じ走査線に 8 台 ＋ 背景 4 個を置く。FC の上限は 8 スプライト/走査線なので、
    // 登録順のうしろにある背景から落ちる。**自機は先頭なので決して落ちない**
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const cars = Array.from({ length: 8 }, (_x, entrant) =>
      entry(entrant, 100, 20, `car-sprite-FC-${entrant}`),
    );
    const scenery = Array.from({ length: 4 }, (_x, index) =>
      entry(NO_ENTITY, 100, 20, `scenery-FC-${index}`),
    );
    const frame = createRenderFrame();
    const culled = pushSpritePlane(frame, { profile, entries: [...cars, ...scenery] });

    expect(profile.video.spritesPerScanline).toBe(8);
    expect(culled).toEqual([NO_ENTITY, NO_ENTITY, NO_ENTITY, NO_ENTITY]);
    for (let entrant = 0; entrant < 8; entrant++) {
      expect(frame.sprites.some((sprite) => sprite.id === `car-sprite-FC-${entrant}`)).toBe(true);
    }
  });
});
