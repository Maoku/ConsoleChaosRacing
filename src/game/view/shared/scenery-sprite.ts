import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import type { RoadView } from './projection.js';
import type { SceneryKind, SceneryObject } from './scenery.js';

/**
 * 擬似3D世代の背景オブジェクト（実装計画 8-6）。
 *
 * **車とまったく同じ 1 本の式**で置く — 距離から大きさを決め、接地線を路面の行へ合わせ、
 * `tileSnap` を持つ世代では接地点を丸める（`car-sprite.ts` の作法そのまま）。
 * スプライト面へ積む順（＝走査線制限の優先度）は
 * **自機 → ミニマップのマーカー → ライバル車 → 背景オブジェクト**で、
 * 混雑したときに最初に消えるのが背景になる。
 */

/** アトラスの形。`tools/build-scenery-sprites.mjs` と共有する */
export const SCENERY_SPRITE_GEOMETRY = {
  columns: 3,
  rows: 1,
  /** 1 セルの一辺 [px] */
  cell: 128,
  /** 種類 → セル番号 */
  cells: { sign: 0, tree: 1, tyres: 2 } satisfies Record<SceneryKind, number>,
} as const;

/**
 * 絵が表す世界の寸法 [m]。**セルいっぱいに焼く**ので、
 * ここの値がそのままスプライトの寸法になる（透明な余りが無いぶん式が 1 本で済む）。
 */
export const SCENERY_ART: Record<SceneryKind, { width: number; height: number }> = {
  sign: { width: 3.2, height: 3.2 },
  tree: { width: 5, height: 7 },
  tyres: { width: 4, height: 1.1 },
};

export interface ScenerySpriteAtlas {
  readonly url: string;
  /** その世代が出す種類。**FC は看板だけ**（8 スプライト/走査線のため） */
  readonly kinds: readonly SceneryKind[];
  /** これより遠い物は描かない [m] */
  readonly drawDistance: number;
  readonly color: string;
}

export const SCENERY_SPRITES: GenerationVariant<ScenerySpriteAtlas | null> =
  defineGenerationVariant({
    FC: {
      url: 'assets/gen1/sprites/scenery.png',
      // 走査線あたり 8 スプライトしか出せないので、種類を看板 1 つに絞る
      kinds: ['sign'],
      drawDistance: 90,
      color: '#ffffff',
    },
    SFC: {
      url: 'assets/gen2/sprites/scenery.png',
      // 32 スプライト/走査線なので木とタイヤフェンスまで置ける
      kinds: ['sign', 'tree', 'tyres'],
      drawDistance: 150,
      color: '#ffffff',
    },
    // 3D の 2 世代はメッシュとワールド空間のビルボードで置く（§3.4）
    PS1: null,
    PS2: null,
  });

export function scenerySpriteAtlasFor(generation: GenerationId): ScenerySpriteAtlas | null {
  return generationValue(SCENERY_SPRITES, generation);
}

export interface ScenerySpritePlacement {
  readonly object: SceneryObject;
  /** 前方距離 [m] */
  readonly distance: number;
  readonly sprite: SpriteCommand;
  /** 走査線制限に渡す矩形（絵のある範囲 ＝ セル全体） */
  readonly y: number;
  readonly height: number;
}

export interface ScenerySpriteOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly view: RoadView;
  readonly track: Track;
  readonly objects: readonly SceneryObject[];
  readonly atlas: ScenerySpriteAtlas;
}

/**
 * 前方にある背景オブジェクトを、遠い順に返す。
 * 返す順がそのまま登録順になり、近い物が後（＝手前）に描かれる。
 */
export function sceneryPlacements(
  options: ScenerySpriteOptions,
): readonly ScenerySpritePlacement[] {
  const { generation, profile, view, track, atlas } = options;
  const snap = Math.max(1, profile.video.tileSnap);
  const nearClip = view.camera.behind * 0.6;
  const farClip = Math.min(atlas.drawDistance, view.maxDistance);
  const placements: ScenerySpritePlacement[] = [];

  for (const object of options.objects) {
    if (!atlas.kinds.includes(object.kind)) continue;
    const distance = track.deltaS(object.s, view.originS);
    if (distance < nearClip || distance > farClip) continue;

    const art = SCENERY_ART[object.kind];
    const scale = view.scaleAt(distance);
    const width = art.width * scale;
    const height = art.height * scale;
    // 車と同じで、丸めるのは中心ではなく**接地点**。中心を丸めると、
    // 大きさが変わるちょうどその瞬間に物が地面から浮く
    const x = view.centerXAt(distance) + object.lateral * scale;
    const ground = view.rowAtDistance(distance);
    const snappedX = Math.round(x / snap) * snap;
    const snappedGround = Math.round(ground / snap) * snap;

    placements.push({
      object,
      distance,
      y: snappedGround - height,
      height,
      sprite: {
        id: `scenery-${generation}-${object.id}`,
        screenSpace: true,
        position: [snappedX, snappedGround - height / 2, 0],
        size: [width, height],
        color: atlas.color,
        texture: atlas.url,
        cell: SCENERY_SPRITE_GEOMETRY.cells[object.kind],
        alphaCutoff: 0.5,
        // 車（20）より奥。半透明は 1 つも付けない（FC の能力契約）
        layer: 18,
        generations: [generation],
      },
    });
  }

  placements.sort((left, right) => right.distance - left.distance);
  return placements;
}
