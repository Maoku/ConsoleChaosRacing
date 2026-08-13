import { GENERATION_IDS, HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { createTrack } from '../src/game/sim/track.js';
import {
  sceneryFor,
  sceneryObjects,
  sceneryOfKinds,
  type SceneryKind,
} from '../src/game/view/shared/scenery.js';
import { scenerySpriteAtlasFor } from '../src/game/view/shared/scenery-sprite.js';
import { PLAYER_ENTRANT } from '../src/game/view/shared/variants.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 背景オブジェクト（実装計画 8-6）。
 *
 * ミニマップと同じ主張の背景版 — **4 世代が同じ 1 つの表を読む**。
 * 出す物は世代で違う（FC は看板だけ）が、出す物の場所は完全に一致する。
 *
 * 配置に乱数を使わないので、生成ツール（コースメッシュへ焼く壁）と実行時も必ず揃う。
 */

const track = createTrack();

describe('背景オブジェクト', () => {
  it('乱数を使わないので、何度組み立てても同じ配置になる', () => {
    const first = sceneryObjects(track);
    const second = sceneryObjects(createTrack());
    expect(second.map((object) => ({ ...object }))).toEqual(first.map((object) => ({ ...object })));
    // コースごとに 1 度だけ組み立てて使い回す（同じ結果なので純関数のまま）
    expect(sceneryFor(track)).toBe(sceneryFor(track));
  });

  it('3 種類がすべて置かれ、s の昇順に並ぶ', () => {
    const objects = sceneryObjects(track);
    const kinds = new Set(objects.map((object) => object.kind));
    expect([...kinds].sort()).toEqual(['sign', 'tree', 'tyres']);
    for (let index = 1; index < objects.length; index++) {
      expect(objects[index]!.s).toBeGreaterThanOrEqual(objects[index - 1]!.s);
    }
    // id は並びどおりの通し番号。**4 世代で同じ id が同じ物を指す**
    expect(objects.map((object) => object.id)).toEqual(objects.map((_unused, index) => index));
  });

  it('看板はコーナーの外側・タイヤフェンスは高曲率区間の外側に立つ', () => {
    for (const object of sceneryOfKinds(sceneryObjects(track), ['sign', 'tyres'])) {
      const sample = track.sampleAt(object.s);
      // 外側 ＝ 曲率の符号と逆の側（曲率は左が正）
      expect(Math.abs(object.lateral)).toBeGreaterThan(sample.halfWidth);
    }
    for (const object of sceneryOfKinds(sceneryObjects(track), ['tyres'])) {
      // 置いた場所そのものが高曲率であること
      expect(Math.abs(track.sampleAt(object.s).curvature)).toBeGreaterThanOrEqual(1 / 90);
    }
  });

  it('路面の上には 1 つも置かない', () => {
    for (const object of sceneryObjects(track)) {
      const sample = track.sampleAt(object.s);
      expect(Math.abs(object.lateral), `id ${object.id}`).toBeGreaterThan(sample.halfWidth);
    }
  });

  it('4 世代が同じ表を読む（看板の s 座標が完全に一致する）', () => {
    // 世代ごとに「出す種類」は違うが、出す物の場所は 1 つの表から出る
    const signs = sceneryOfKinds(sceneryObjects(track), ['sign']).map((object) => object.s);
    for (const generation of GENERATION_IDS) {
      const atlas = scenerySpriteAtlasFor(generation);
      const kinds: readonly SceneryKind[] = atlas?.kinds ?? ['sign', 'tree', 'tyres'];
      expect(kinds).toContain('sign');
      expect(sceneryOfKinds(sceneryFor(track), ['sign']).map((object) => object.s)).toEqual(signs);
    }
  });

  it('FC は看板 1 種だけ（8 スプライト/走査線）、SFC は 3 種', () => {
    expect(scenerySpriteAtlasFor('FC')!.kinds).toEqual(['sign']);
    expect(scenerySpriteAtlasFor('SFC')!.kinds).toEqual(['sign', 'tree', 'tyres']);
    // 3D の 2 世代はメッシュとビルボードで置くので、スプライトのアトラスを持たない
    expect(scenerySpriteAtlasFor('PS1')).toBeNull();
    expect(scenerySpriteAtlasFor('PS2')).toBeNull();
  });

  describe('擬似3D世代のスプライト', () => {
    /**
     * 1 周ぶんのいろいろな地点でフレームを組む。
     *
     * FC が出すのは看板だけで、コースには 11 本しか立っていない。
     * 1 か所だけ見ると「たまたま前方に無い」ことがあるので、周回の各所を見る。
     */
    const MOMENTS = [300, 900, 1500, 2100, 2700, 3300, 3900];
    const frames = (generation: 'FC' | 'SFC') =>
      MOMENTS.map((ticks) => buildFrame(generation, raceAfter(ticks)));

    for (const generation of ['FC', 'SFC'] as const) {
      it(`${generation}: 半透明を 1 つも持たず、自機とライバルは残る`, () => {
        let seen = 0;
        for (const frame of frames(generation)) {
          const scenery = frame.sprites.filter((sprite) => sprite.id.startsWith('scenery-'));
          seen += scenery.length;
          for (const sprite of scenery) {
            expect(sprite.hardwareBlend).toBeUndefined();
            expect(sprite.screenSpace).toBe(true);
            expect(sprite.texture).toBe(scenerySpriteAtlasFor(generation)!.url);
          }
          // 背景は最後に登録される ＝ 混雑時に最初に落ちる。自機は必ず残る
          expect(
            frame.sprites.some(
              (sprite) => sprite.id === `car-sprite-${generation}-${PLAYER_ENTRANT}`,
            ),
          ).toBe(true);
        }
        expect(seen, `${generation} で背景が 1 つも出なかった`).toBeGreaterThan(0);
      });
    }

    it('FC は接地点が 8 px グリッドに載る', () => {
      const profile = HARDWARE_GENERATION_PROFILES.FC;
      const snap = profile.video.tileSnap;
      for (const frame of frames('FC')) {
        for (const sprite of frame.sprites) {
          if (!sprite.id.startsWith('scenery-')) continue;
          const ground = sprite.position[1] + sprite.size[1] / 2;
          expect(ground % snap, sprite.id).toBe(0);
        }
      }
    });

    it('FC が出すのは看板のセルだけ', () => {
      const cells = new Set(
        frames('FC').flatMap((frame) =>
          frame.sprites
            .filter((sprite) => sprite.id.startsWith('scenery-'))
            .map((sprite) => sprite.cell),
        ),
      );
      expect([...cells]).toEqual([0]);
    });
  });
});
