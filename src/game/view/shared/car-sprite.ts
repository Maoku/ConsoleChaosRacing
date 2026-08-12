import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import type { DisplayCar } from './display-state.js';
import type { RoadView } from './projection.js';
import { PLAYER_ENTRANT } from './variants.js';

/**
 * 擬似3D世代の車スプライト（実装計画 §3.2 / §3.3）。
 *
 * アトラスは 3 列 × 2 行、1 セル 128²。列は左傾き / 正面 / 右傾き、
 * 行は黄（自機）と赤（ライバル）。第1世代は同時 25 色なので、
 * **8 台を色分けせず「自機は黄・ライバルは赤」の 2 色に留める**のが実機の作法に合う
 * （ミニマップのマーカーが 2 色なのと同じ理由。§3.6）。
 *
 * 描くのは `tools/build-car-sprites.mjs` が整形した `car_frames.png` のほうで、
 * 同梱の `cars.png` は入力として残してある。元の絵はセル境界を 2 px はみ出していて、
 * 正面のセルを描くと両端に隣の車の破片が出るため（ツールの冒頭に詳しく書いた）。
 */

/** 整形後のアトラスの形。ツールとビューが共有する */
export const CAR_SPRITE_GEOMETRY = {
  columns: 3,
  rows: 2,
  /** 1 セルの一辺 [px] */
  cell: 128,
  /** 接地線（絵の下端）をセルのどこへ揃えるか（上端 0・下端 1） */
  groundFraction: 0.86,
  /**
   * 絵そのものの高さがセルに占める割合（切り上げ）。
   * 走査線制限は**絵のある行だけ**を数える（セルの透明部分は実機ではタイルを消費しない）。
   */
  heightFraction: 0.44,
} as const;

/** 整形の入出力。`manifest.ts` は `to` のほうを登録する */
export const CAR_SPRITE_SOURCES = [
  { from: 'assets/gen1/sprites/cars.png', to: 'assets/gen1/sprites/car_frames.png' },
  { from: 'assets/gen2/sprites/cars.png', to: 'assets/gen2/sprites/car_frames.png' },
] as const;

export interface CarSpriteRow {
  /** 行の先頭セル番号。+0 が左傾き、+1 が正面、+2 が右傾き */
  readonly firstCell: number;
  /** 接地線がセルのどこにあるか（上端 0・下端 1） */
  readonly groundFraction: number;
  /** 絵そのものの高さがセルに占める割合 */
  readonly heightFraction: number;
}

export interface CarSpriteAtlas {
  readonly url: string;
  /** 1 セルが表す世界の一辺 [m]。正面の車の全幅が 1.95 m になるよう決めてある */
  readonly cellMeters: number;
  readonly player: CarSpriteRow;
  readonly rival: CarSpriteRow;
}

/** 整形後はどのセルも接地線と絵の高さが揃うので、行ごとの違いはセル番号だけになる */
const ROW = {
  firstCell: 0,
  groundFraction: CAR_SPRITE_GEOMETRY.groundFraction,
  heightFraction: CAR_SPRITE_GEOMETRY.heightFraction,
} as const;

export const CAR_SPRITES: GenerationVariant<CarSpriteAtlas | null> = defineGenerationVariant({
  FC: {
    url: CAR_SPRITE_SOURCES[0].to,
    cellMeters: 3.08,
    player: { ...ROW, firstCell: 0 },
    rival: { ...ROW, firstCell: 3 },
  },
  SFC: {
    url: CAR_SPRITE_SOURCES[1].to,
    cellMeters: 3.01,
    player: { ...ROW, firstCell: 0 },
    rival: { ...ROW, firstCell: 3 },
  },
  PS1: null,
  PS2: null,
});

export function carSpriteAtlasFor(generation: GenerationId): CarSpriteAtlas | null {
  return generationValue(CAR_SPRITES, generation);
}

/** 走査線制限と描画で共有する、1 台ぶんのスプライトの寸法 */
export interface CarSpritePlacement {
  readonly entrant: number;
  readonly isPlayer: boolean;
  /** 前方距離 [m]。自機は 0 */
  readonly distance: number;
  /** 中心の画面座標 */
  readonly position: readonly [number, number];
  /** 一辺 [px] */
  readonly size: number;
  readonly cell: number;
}

/**
 * 傾きのセルを選ぶ。1 が正面。
 *
 * ## 列と向きの対応（絵を実測して確定）
 *
 * 列 0 の絵は、車のノーズが画面の右奥を向き、見えている側面が**車の右側**になっている。
 * 追走カメラから車の右側面が見えるのは車が**右へ向きを変えたとき**なので、
 * **列 0 = 右コーナー・列 2 = 左コーナー**である。実装計画が「左傾き / 正面 / 右傾き」と
 * 書いているのは車体のロール方向のことで、右コーナーでは車体は左へ傾く（外側へ）。
 * 素直に「左 → 0」と読むと左右が逆になる。
 *
 * ## 判定に使う量
 *
 * **横加速度**（`speed × ヨー角速度`）を見る。コース接線に対するヨー角では、
 * 曲がれている間は車体が接線に沿うので値がほぼ 0 になり、コーナーの最中に
 * 絵が正面へ戻ってしまう。横加速度ならコーナーの間ずっと符号が立つ。
 * `CarState` がこの値を「車体ロールの元」として持っているのもそのため。
 */
export function steerCellOffset(car: DisplayCar, threshold = 3.5): number {
  if (car.lateralAccel > threshold) return 0;
  if (car.lateralAccel < -threshold) return 2;
  return 1;
}

export interface CarPlacementOptions {
  readonly view: RoadView;
  readonly track: Track;
  readonly profile: HardwareGenerationProfile;
  readonly atlas: CarSpriteAtlas;
  /** これより近い車は描かない [m]。路面帯の下端より手前は画面に無い */
  readonly nearClip?: number;
  /**
   * これより遠い車は描かない [m]。既定は描画距離そのもの。
   * 遠方をフォグで潰す世代では、霞の向こうに点が残らないよう手前で切る。
   */
  readonly farClip?: number;
}

/**
 * 1 台ぶんの配置。**自機もライバルもこの 1 本の式で置く。**
 * カメラが自機の後方にあるので、自機は距離 `camera.behind` の車として素直に扱える。
 */
function place(
  options: CarPlacementOptions,
  car: DisplayCar,
  distance: number,
  isPlayer: boolean,
): CarSpritePlacement {
  const { view, atlas } = options;
  const row = isPlayer ? atlas.player : atlas.rival;
  const size = (atlas.cellMeters * view.camera.focal) / distance;
  const ground = view.rowAtDistance(distance);
  const x = view.centerXAt(distance) + car.lateral * view.scaleAt(distance);
  return {
    entrant: car.entrant,
    isPlayer,
    distance,
    position: [x, ground - (row.groundFraction - 0.5) * size],
    size,
    cell: row.firstCell + steerCellOffset(car),
  };
}

/** 自機。カメラの `behind` メートル前方に居る */
export function playerPlacement(options: CarPlacementOptions, car: DisplayCar): CarSpritePlacement {
  return place(options, car, options.view.camera.behind, true);
}

/**
 * ライバルの位置。カメラより前にいる車だけを、距離順（遠い順）に返す。
 * 返す順がそのまま登録順になり、近い車が後（＝手前）に描かれる。
 */
export function rivalPlacements(
  options: CarPlacementOptions,
  cars: readonly DisplayCar[],
  origin: DisplayCar,
): CarSpritePlacement[] {
  const { view, track } = options;
  const nearClip = options.nearClip ?? view.camera.behind * 0.6;
  const farClip = options.farClip ?? view.maxDistance;
  const placements: CarSpritePlacement[] = [];

  for (const car of cars) {
    if (car.entrant === origin.entrant) continue;
    const distance = track.deltaS(car.s, view.originS);
    if (distance < nearClip || distance > farClip) continue;
    placements.push(place(options, car, distance, false));
  }

  placements.sort((left, right) => right.distance - left.distance);
  return placements;
}

/**
 * 配置 → `SpriteCommand`。
 *
 * `tileSnap` を持つ世代（FC）では配置座標を 8 px に丸める（能力契約 §1.4）。
 * 丸めるのは中心ではなく**接地点**にする。中心を丸めると、大きさが変わる
 * ちょうどその瞬間に車が路面から浮く。
 */
export function carSpriteCommand(
  placement: CarSpritePlacement,
  atlas: CarSpriteAtlas,
  profile: HardwareGenerationProfile,
  generation: GenerationId,
  color = '#ffffff',
): SpriteCommand {
  const snap = Math.max(1, profile.video.tileSnap);
  const row = placement.isPlayer ? atlas.player : atlas.rival;
  const ground = placement.position[1] + (row.groundFraction - 0.5) * placement.size;
  const snappedX = Math.round(placement.position[0] / snap) * snap;
  const snappedGround = Math.round(ground / snap) * snap;

  return {
    id: `car-sprite-${generation}-${placement.entrant}`,
    screenSpace: true,
    position: [snappedX, snappedGround - (row.groundFraction - 0.5) * placement.size, 0],
    size: [placement.size, placement.size],
    color,
    texture: atlas.url,
    cell: placement.cell,
    alphaCutoff: 0.5,
    layer: 20,
    generations: [generation],
  };
}

/**
 * 走査線制限に渡す矩形。`y` は上端、`height` は高さ（エンジンの規約）。
 *
 * セル全体ではなく**絵のある範囲**を渡す。セルの上半分は透明で、実機なら
 * そもそもタイルを置かない領域であり、ここを数えると制限が過剰に効く。
 */
export function scanlineItem(sprite: SpriteCommand, row: CarSpriteRow, entity: number) {
  const size = sprite.size[1];
  const ground = sprite.position[1] + (row.groundFraction - 0.5) * size;
  const height = row.heightFraction * size;
  return { entity, y: ground - height, height };
}

export { PLAYER_ENTRANT };
