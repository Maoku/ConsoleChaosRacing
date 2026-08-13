import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { GENERATION_IDS, HARDWARE_GENERATION_PROFILES } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { createTrack } from '../src/game/sim/track.js';
import {
  sceneryFor,
  sceneryObjects,
  sceneryOfKinds,
  type SceneryKind,
} from '../src/game/view/shared/scenery.js';
import { tyreWallDrawDistance } from '../src/game/view/shared/scenery-mesh.js';
import {
  SCENERY_SPRITE_GEOMETRY,
  sceneryBillboardAtlasFor,
  scenerySpriteAtlasFor,
} from '../src/game/view/shared/scenery-sprite.js';
import { PLAYER_ENTRANT } from '../src/game/view/shared/variants.js';
import { decodePng } from '../tools/lib/png.mjs';
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
    // 3D の 2 世代はメッシュとビルボードで置くので、スクリーン空間の表を持たない
    expect(scenerySpriteAtlasFor('PS1')).toBeNull();
    expect(scenerySpriteAtlasFor('PS2')).toBeNull();
  });

  it('3D 世代はビルボードが木だけ、タイヤフェンスは第4世代のメッシュ', () => {
    for (const generation of ['PS1', 'PS2'] as const) {
      expect(sceneryBillboardAtlasFor(generation)!.kinds).toEqual(['tree']);
    }
    expect(sceneryBillboardAtlasFor('FC')).toBeNull();
    expect(sceneryBillboardAtlasFor('SFC')).toBeNull();
    // 第3世代にタイヤフェンスは置かない（スロットとドローコールを増やさない）
    expect(tyreWallDrawDistance('PS1')).toBeNull();
    expect(tyreWallDrawDistance('PS2')).toBeGreaterThan(0);
  });

  /**
   * 焼いた絵の向き。**スクリーン空間とワールド空間で要求が逆**になる。
   *
   * スクリーン空間スプライトのクアッドは `ortho(0, W, H, 0)` を通るので画像の上端が
   * スプライトの下端へ割り当たり、絵を上下反転して焼くのが正しい（車・フォントと同じ）。
   * ワールド空間のビルボードにはその反転が無く、同じ絵を貼ると**木が逆さまに立つ**
   * — 実画面で起きた。例外にならないので、ここで向きを固定する。
   */
  describe('焼いた絵の向き', () => {
    /** 木のセルの中で、幹（画像の下寄りの細い塊）がどちら側にあるか */
    function trunkAtImageTop(url: string, cellSize: number): boolean {
      const image = decodePng(readFileSync(join(process.cwd(), 'public', url)));
      const column = SCENERY_SPRITE_GEOMETRY.cells.tree * cellSize;
      let top = 0;
      let bottom = 0;
      for (let y = 0; y < cellSize; y++) {
        let opaque = 0;
        for (let x = 0; x < cellSize; x++) {
          if (image.pixels[((y * image.width + column + x) * 4) + 3]! >= 8) opaque += 1;
        }
        // 幹の行は不透明な画素がごく少ない（葉の塊は広い）
        if (opaque === 0) continue;
        if (y < cellSize / 2) top += opaque;
        else bottom += opaque;
      }
      // 葉の塊のあるほうが「木の上」。幹はその反対側
      return bottom > top;
    }

    it('擬似3D 世代は上下反転して焼いてある', () => {
      for (const generation of ['FC', 'SFC'] as const) {
        const atlas = scenerySpriteAtlasFor(generation)!;
        expect(atlas.flipCells).toBe(true);
        expect(trunkAtImageTop(atlas.url, atlas.cellSize), generation).toBe(true);
      }
    });

    it('3D 世代のビルボードは反転せずに焼いてある', () => {
      for (const generation of ['PS1', 'PS2'] as const) {
        const atlas = sceneryBillboardAtlasFor(generation)!;
        expect(atlas.flipCells).toBe(false);
        // 葉が画像の上・幹が下。ワールド空間ではこれがそのまま立つ向きになる
        expect(trunkAtImageTop(atlas.url, atlas.cellSize), generation).toBe(false);
      }
    });
  });

  describe('3D 世代', () => {
    const state = raceAfter(900);

    it('PS1: 木は車と同じスロット 9 に入る（深度バッファが無いため）', () => {
      const frame = buildFrame('PS1', state);
      const trees = frame.sprites.filter((sprite) => sprite.id.startsWith('scenery-PS1-'));
      expect(trees.length).toBeGreaterThan(0);
      for (const tree of trees) {
        expect(tree.orderTableIndex).toBe(9);
        expect(tree.billboard).toBe('cylindrical');
        expect(tree.screenSpace).toBeUndefined();
      }
      // 第3世代にタイヤフェンスのメッシュは無い
      expect(frame.meshes.filter((mesh) => mesh.id.startsWith('tyre-wall-'))).toEqual([]);
    });

    it('PS2: 描画順の指定を 1 つも持たない（深度バッファがある）', () => {
      const frame = buildFrame('PS2', state);
      const trees = frame.sprites.filter((sprite) => sprite.id.startsWith('scenery-PS2-'));
      expect(trees.length).toBeGreaterThan(0);
      for (const tree of trees) {
        expect(tree.orderTableIndex).toBeUndefined();
        expect(tree.depthWrite).toBe(true);
        expect(tree.billboard).toBe('cylindrical');
      }
      const tyres = frame.meshes.filter((mesh) => mesh.id.startsWith('tyre-wall-PS2-'));
      expect(tyres.length).toBeGreaterThan(0);
      for (const mesh of tyres) {
        expect(mesh.orderTableIndex).toBeUndefined();
        expect(mesh.polygonSortRange).toBeUndefined();
        // 路面と同じアトラスの帯を引くので、マテリアルは増えない
        expect(mesh.material).toBe('track-PS2');
      }
    });

    it('壁はコースメッシュへ焼き込んであり、別メッシュとしては積まれない', () => {
      // `TransformCommand` に X/Z 回転が無い以上、バンクのついた路面に沿う壁は
      // 別メッシュでは置けない（§1.3）。焼き込みは `track-mesh.spec.ts` が検査する
      for (const generation of ['PS1', 'PS2'] as const) {
        const frame = buildFrame(generation, state);
        expect(frame.meshes.filter((mesh) => mesh.id.includes('wall-mesh'))).toEqual([]);
      }
    });
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
