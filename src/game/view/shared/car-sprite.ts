import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import { ENTRANT_COUNT } from '../../sim/state.js';
import type { Track } from '../../sim/track.js';
import type { DisplayCar } from './display-state.js';
import type { RoadView } from './projection.js';
import { PLAYER_ENTRANT } from './variants.js';

/**
 * 擬似3D世代の車スプライト（実装計画 §3.2 / §3.3）。
 *
 * アトラスは 3 列 × 2 行、1 セル 128²。列は左傾き / 正面 / 右傾き、
 * 行は黄（自機）と赤（ライバル）。第1世代は同時 25 色なので、
 * **第1世代は 8 台を色分けせず「自機は黄・ライバルは赤」の 2 色に留める**のが実機の
 * 作法に合う（同時 25 色の契約。ミニマップのマーカーが 2 色なのと同じ理由。§3.6）。
 * **第2世代は 8 行 ＝ 8 パレット**で、絵は 1 つのまま色だけが 8 通りになる（11-1・D-1）。
 *
 * 描くのは `tools/build-car-sprites.mjs` が整形した `car_frames.png` のほうで、
 * 同梱の `cars.png` は入力として残してある。元の絵はセル境界を 2 px はみ出していて、
 * 正面のセルを描くと両端に隣の車の破片が出るため（ツールの冒頭に詳しく書いた）。
 */

/**
 * 整形後のアトラスの形。ツールとビューが共有する。
 *
 * 行の意味は世代で変わる（`perEntrant`）。第2世代は実機の「1 タイルセット + 8 パレット」に
 * 対応させ、**8 行すべてが同じインデックス地図**で、違うのはパレットだけになる。
 */
export interface CarSpriteLayout {
  readonly columns: number;
  readonly rows: number;
  /** 1 セルの一辺 [px] */
  readonly cell: number;
  /** 接地線（絵の下端）をセルのどこへ揃えるか（上端 0・下端 1） */
  readonly groundFraction: number;
  /**
   * 絵そのものの高さがセルに占める割合（切り上げ）。
   * 走査線制限は**絵のある行だけ**を数える（セルの透明部分は実機ではタイルを消費しない）。
   */
  readonly heightFraction: number;
  /**
   * 真なら 1 行 ＝ 1 エントラント（パレット替え）。偽なら自機／ライバルの 2 行。
   * 第1世代を 2 行に留めるのは同時 25 色の契約による（実装計画 D-2）。
   */
  readonly perEntrant: boolean;
}

/** 世代で変わらない部分。列の並びも接地線も整形ツールが揃える */
const SHAPE = {
  columns: 3,
  cell: 128,
  groundFraction: 0.86,
  heightFraction: 0.44,
} as const;

export const CAR_SPRITE_GEOMETRY: GenerationVariant<CarSpriteLayout | null> =
  defineGenerationVariant({
    FC: { ...SHAPE, rows: 2, perEntrant: false },
    // 行数は出走台数そのもの。台数を変えたときにアトラスの焼き直しを忘れられない
    SFC: { ...SHAPE, rows: ENTRANT_COUNT, perEntrant: true },
    PS1: null,
    PS2: null,
  });

export function carSpriteLayoutFor(generation: GenerationId): CarSpriteLayout | null {
  return generationValue(CAR_SPRITE_GEOMETRY, generation);
}

/** 整形の入出力。`manifest.ts` は `to` のほうを登録する */
export const CAR_SPRITE_SOURCES = [
  {
    generation: 'FC',
    from: 'assets/gen1/sprites/cars.png',
    to: 'assets/gen1/sprites/car_frames.png',
  },
  {
    generation: 'SFC',
    from: 'assets/gen2/sprites/cars.png',
    to: 'assets/gen2/sprites/car_frames.png',
  },
] as const satisfies readonly {
  generation: GenerationId;
  from: string;
  to: string;
}[];

export interface CarSpriteRow {
  /** 行の先頭セル番号。+0 が右コーナー、+1 が正面、+2 が左コーナー */
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
  readonly layout: CarSpriteLayout;
}

export const CAR_SPRITES: GenerationVariant<CarSpriteAtlas | null> = defineGenerationVariant({
  FC: {
    url: CAR_SPRITE_SOURCES[0].to,
    cellMeters: 3.08,
    layout: CAR_SPRITE_GEOMETRY.FC!,
  },
  SFC: {
    url: CAR_SPRITE_SOURCES[1].to,
    cellMeters: 3.01,
    layout: CAR_SPRITE_GEOMETRY.SFC!,
  },
  PS1: null,
  PS2: null,
});

/**
 * その車が使う行。パレット替えを持たない世代は自機／ライバルの 2 行に落とす（D-2）。
 *
 * **ここが「1 台 = 1 パレット」の唯一の入口**で、行の意味を知っているのはこの関数だけになる。
 */
export function spriteRowFor(atlas: CarSpriteAtlas, entrant: number): number {
  if (!atlas.layout.perEntrant) return entrant === PLAYER_ENTRANT ? 0 : 1;
  return Math.min(atlas.layout.rows - 1, Math.max(0, entrant));
}

/** 行 → セルの起点と接地線。整形後はどの行も接地線と絵の高さが揃う */
export function carSpriteRow(atlas: CarSpriteAtlas, entrant: number): CarSpriteRow {
  const { columns, groundFraction, heightFraction } = atlas.layout;
  return {
    firstCell: spriteRowFor(atlas, entrant) * columns,
    groundFraction,
    heightFraction,
  };
}

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
 * ステアフレームへ移る条件（実装計画 8-1）。
 *
 * **2 つの閾値の AND** で判定する。片方（横加速度）だけだと、直線での小さな
 * 修正舵と AI の車線取りが閾値を跨ぎ、6Hz / 12Hz の量子化と重なって
 * 絵がパタパタ切り替わる。もう片方（コース曲率）を AND で噛ませると、
 * 直線区間ではどれだけ舵を当てても正面のセルのままになる。
 *
 * **ヒステリシスは入れない。** 「ビューは状態を持たない純関数」（§2.1）を崩さない
 * ためで、二重閾値ではなく AND ゲートで解決する。
 */
export interface SteerFrameThresholds {
  /** これを超える横加速度で傾きのセルへ移る [m/s²] */
  readonly lateralAccel: number;
  /** これを超える曲率の区間だけを「カーブ」とみなす [1/m] */
  readonly curvature: number;
}

/**
 * 世代ごとの閾値。更新レートが違うと切り替わりの見え方も違うので、
 * 6Hz と 12Hz で別々に調整できるよう 1 つの表に出してある。
 * 擬似3D でない世代（PS1 / PS2）はスプライトを使わないので値は読まれない。
 */
export const STEER_FRAME: GenerationVariant<SteerFrameThresholds> = defineGenerationVariant({
  // 半径 240 m 未満をカーブとみなす。ホームストレートとシケイン間の直線が外れる
  FC: { lateralAccel: 5, curvature: 1 / 240 },
  SFC: { lateralAccel: 5, curvature: 1 / 240 },
  PS1: { lateralAccel: 5, curvature: 1 / 240 },
  PS2: { lateralAccel: 5, curvature: 1 / 240 },
});

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
 * 向きを決めるのは**横加速度**（`speed × ヨー角速度`）である。コース接線に対する
 * ヨー角では、曲がれている間は車体が接線に沿うので値がほぼ 0 になり、コーナーの
 * 最中に絵が正面へ戻ってしまう。横加速度ならコーナーの間ずっと符号が立つ。
 * `CarState` がこの値を「車体ロールの元」として持っているのもそのため。
 *
 * **いつ正面へ戻すか**を決めるのがコース曲率のほうで、こちらは門にしか使わない
 * （8-1）。直線では絵が正面から動かず、カーブでは横加速度の符号どおりに傾く。
 */
export function steerCellOffset(
  car: Pick<DisplayCar, 'lateralAccel'>,
  curvature: number,
  thresholds: SteerFrameThresholds,
): number {
  // 直線区間（κ ≒ 0）ではどれだけ舵を当てても正面のまま
  if (Math.abs(curvature) < thresholds.curvature) return 1;
  if (car.lateralAccel > thresholds.lateralAccel) return 0;
  if (car.lateralAccel < -thresholds.lateralAccel) return 2;
  return 1;
}

export interface CarPlacementOptions {
  readonly view: RoadView;
  readonly track: Track;
  readonly profile: HardwareGenerationProfile;
  /** ステアフレームの閾値を引くのに要る（`STEER_FRAME`・8-1） */
  readonly generation: GenerationId;
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
  const { view, track, atlas } = options;
  const row = carSpriteRow(atlas, car.entrant);
  const size = (atlas.cellMeters * view.camera.focal) / distance;
  const ground = view.rowAtDistance(distance);
  const x = view.centerXAt(distance) + car.lateral * view.scaleAt(distance);
  // 曲率は車が**いま居る場所**のもの。舵ではなくコースの形が門になる（8-1）
  const curvature = track.sampleAt(car.s).curvature;
  return {
    entrant: car.entrant,
    isPlayer,
    distance,
    position: [x, ground - (row.groundFraction - 0.5) * size],
    size,
    cell:
      row.firstCell +
      steerCellOffset(car, curvature, generationValue(STEER_FRAME, options.generation)),
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
  const row = carSpriteRow(atlas, placement.entrant);
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
