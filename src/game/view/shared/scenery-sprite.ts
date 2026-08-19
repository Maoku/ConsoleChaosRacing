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
import type { SceneryKind, SceneryObject } from '../../sim/scenery.js';

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
export interface SceneryAtlasLayout {
  readonly columns: number;
  readonly rows: number;
  /**
   * 種類 → セル番号の候補。**候補が 2 つ以上あるとき、どれを引くかは `id` で決まる。**
   * 乱数を使わないので、同じ木は何度描いても同じ絵になる（`scenery.ts` と同じ方針）。
   */
  readonly cells: Readonly<Record<SceneryKind, readonly number[]>>;
}

/**
 * 3 セル 1 行。第1〜第3世代が共有する。
 * 1 種類につき絵は 1 枚で、木は全部同じ形に見える。
 */
export const SCENERY_SPRITE_GEOMETRY: SceneryAtlasLayout = {
  columns: 3,
  rows: 1,
  cells: { sign: [0], tree: [1], tyres: [2] },
};

/**
 * 第4世代だけのアトラス（実装計画 8-10）。**3 × 2 の 6 セル**。
 *
 * 木を 3 種類（広葉樹 2 種・針葉樹 1 種）持ち、看板も 2 種類ある。
 * 同じ 25 m 間隔で並んでいても、隣の木と形が違うので並木が「同じ絵の反復」に
 * 見えない — 実画面で初版のいちばん目立った粗さがそれだった。
 * セルは 256²（第3世代の 128² の 4 倍）で、幹と枝の分かれ目まで描く。
 */
export const SCENERY_BILLBOARD_GEOMETRY: SceneryAtlasLayout = {
  columns: 3,
  rows: 2,
  cells: { sign: [0, 5], tree: [1, 3, 4], tyres: [2] },
};

/** その物が引くセル。候補が複数あるときは `id` で選ぶ */
export function sceneryCell(layout: SceneryAtlasLayout, object: SceneryObject): number {
  const cells = layout.cells[object.kind];
  return cells[object.id % cells.length] ?? 0;
}

/**
 * 絵が表す世界の寸法 [m]。**セルいっぱいに焼く**ので、
 * ここの値がそのままスプライトの縦横比になる（透明な余りが無いぶん式が 1 本で済む）。
 *
 * 実際の大きさは `SceneryObject.height` で決まり、幅はこの比から出す。
 * **高さは 1 つの表（`scenery.ts`）から出る**ので、木の背丈がばらついていても
 * 4 世代で同じ木が同じ背丈に描かれる。
 */
export const SCENERY_ART: Record<SceneryKind, { width: number; height: number }> = {
  sign: { width: 3.2, height: 3.2 },
  tree: { width: 5, height: 7 },
  tyres: { width: 4, height: 1.1 },
};

/** その物の世界での寸法 [m]。縦は表の値そのもの、横は絵の縦横比から */
function artSize(object: SceneryObject): { width: number; height: number } {
  const art = SCENERY_ART[object.kind];
  return { width: (art.width * object.height) / art.height, height: object.height };
}

export interface ScenerySpriteAtlas {
  readonly url: string;
  /** セルの並びと、種類ごとのセル候補 */
  readonly layout: SceneryAtlasLayout;
  /** 1 セルの一辺 [px]。生成ツールだけが使う（解像度の上がる世代は大きく焼く） */
  readonly cellSize: number;
  /** その世代が出す種類。**FC は看板だけ**（8 スプライト/走査線のため） */
  readonly kinds: readonly SceneryKind[];
  /** これより遠い物は描かない [m] */
  readonly drawDistance: number;
  /**
   * これより遠い物は**1 つおきに間引く** [m]（ビルボードのみ）。
   *
   * 木は 25 m 間隔で左右に立つので、描画距離を伸ばすとドローコールがそのまま増える
   * （§6.3 の 240 コール予算に当たった）。遠方はフォグが 8 割を超えていて
   * 間引いても気付かないので、当時の実機と同じように距離で密度を落とす。
   */
  readonly thinBeyond?: number;
  /**
   * セルの中で**上下を反転して焼く**か（生成ツールだけが使う）。
   *
   * スクリーン空間スプライトと**ワールド空間のビルボードで向きの要求が逆**になる
   * （実画面で確認）。スクリーン空間のクアッドは `ortho(0, W, H, 0)` を通るので
   * 画像の上端がスプライトの下端へ割り当たり、絵を反転して焼くのが正しい
   * （車スプライト・フォントと同じ規約）。ワールド空間ではその反転が無いので、
   * 同じ絵を使うと**木が逆さまに立つ**。焼き方をここで分ける。
   */
  readonly flipCells: boolean;
  readonly color: string;
}

/** 擬似3D 世代（スクリーン空間スプライトとして置く） */
export const SCENERY_SPRITES: GenerationVariant<ScenerySpriteAtlas | null> =
  defineGenerationVariant({
    FC: {
      url: 'assets/gen1/sprites/scenery.png',
      layout: SCENERY_SPRITE_GEOMETRY,
      cellSize: 128,
      // 走査線あたり 8 スプライトしか出せないので、種類を看板 1 つに絞る
      kinds: ['sign'],
      drawDistance: 90,
      // スクリーン空間スプライトなので反転して焼く
      flipCells: true,
      color: '#ffffff',
    },
    SFC: {
      url: 'assets/gen2/sprites/scenery.png',
      layout: SCENERY_SPRITE_GEOMETRY,
      cellSize: 128,
      // 32 スプライト/走査線なので木とタイヤフェンスまで置ける
      kinds: ['sign', 'tree', 'tyres'],
      drawDistance: 150,
      flipCells: true,
      color: '#ffffff',
    },
    PS1: null,
    PS2: null,
  });

/**
 * 3D 世代（ワールド空間のビルボードとして置く）。
 *
 * **木だけ**がビルボードで、壁はコースメッシュへ焼き込み、
 * タイヤフェンスは第4世代だけが専用メッシュで置く（8-6 の表）。
 * 描画距離はそれぞれの `CAR_DRAW_DISTANCE` と揃えてあり、フォグが閉じる範囲に収まる。
 */
export const SCENERY_BILLBOARDS: GenerationVariant<ScenerySpriteAtlas | null> =
  defineGenerationVariant({
    FC: null,
    SFC: null,
    PS1: {
      url: 'assets/gen3/sprites/scenery.png',
      layout: SCENERY_SPRITE_GEOMETRY,
      cellSize: 128,
      kinds: ['tree'],
      drawDistance: 100,
      // ワールド空間のビルボードは反転しない（反転すると木が逆さまに立つ）
      flipCells: false,
      color: '#ffffff',
    },
    PS2: {
      url: 'assets/gen4/sprites/scenery.png',
      // 6 セル。木 3 種・看板 2 種を持つのはこの世代だけ（8-10）
      layout: SCENERY_BILLBOARD_GEOMETRY,
      cellSize: 256,
      // 看板も出す。**4 世代で同じ場所に同じ看板が立つ**という 8-6 の主張は、
      // 出していない世代があるうちは絵として確かめられない
      kinds: ['sign', 'tree'],
      drawDistance: 280,
      // 280 m ぶんを全部積むとドローコールが 240 の予算を超えた（実測 245）。
      // 120 m より遠い木を 1 つおきにする。フォグが 8 割の距離なので見た目は変わらない
      thinBeyond: 120,
      flipCells: false,
      color: '#ffffff',
    },
  });

export function scenerySpriteAtlasFor(generation: GenerationId): ScenerySpriteAtlas | null {
  return generationValue(SCENERY_SPRITES, generation);
}

export function sceneryBillboardAtlasFor(generation: GenerationId): ScenerySpriteAtlas | null {
  return generationValue(SCENERY_BILLBOARDS, generation);
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
  /**
   * これより遠い物を描かない [m]。省略すると `atlas.drawDistance` と視界の遠い方で切る。
   * トンネルの坑口の壁で視界が塞がれるときに、その距離が渡ってくる（8-9）。
   */
  readonly farClip?: number;
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
  const farClip = Math.min(
    atlas.drawDistance,
    view.maxDistance,
    options.farClip ?? Number.POSITIVE_INFINITY,
  );
  const placements: ScenerySpritePlacement[] = [];

  for (const object of options.objects) {
    if (!atlas.kinds.includes(object.kind)) continue;
    const distance = track.deltaS(object.s, view.originS);
    if (distance < nearClip || distance > farClip) continue;

    const art = artSize(object);
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
        cell: sceneryCell(atlas.layout, object),
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

export interface SceneryBillboardOptions {
  readonly generation: GenerationId;
  readonly track: Track;
  readonly objects: readonly SceneryObject[];
  readonly atlas: ScenerySpriteAtlas;
  /** カメラの位置。描画距離の判定に使う */
  readonly camera: readonly [number, number, number];
  /**
   * 深度バッファの無い世代（第3世代）で入れる固定スロット。
   * **車と同じスロットへ入れる** — スロットの中身はレンダラーが view depth で
   * 安定ソートするので（実測: 0..9 のスロットは遠い順に並べ替えられる）、
   * 木と車の前後が破綻しない。第4世代では**指定しない**ことがそのまま世代差になる。
   */
  readonly orderTableIndex?: number;
  /** 深度バッファを持つ世代では不透明として書き込む */
  readonly depthWrite?: boolean;
}

/**
 * 3D 世代の木（実装計画 8-6）。ワールド空間のビルボード。
 *
 * 実測: `writeSpriteModelMatrix` は `screenSpace` でないスプライトへ
 * 既定で `cylindrical` を適用する。明示しておくのは意図の記録。
 */
export function sceneryBillboards(options: SceneryBillboardOptions): SpriteCommand[] {
  const { generation, track, atlas, camera } = options;
  const sprites: SpriteCommand[] = [];

  for (const object of options.objects) {
    if (!atlas.kinds.includes(object.kind)) continue;
    const ground = track.toWorld(object.s, object.lateral);
    const away = Math.hypot(
      ground[0] - camera[0],
      ground[1] - camera[1],
      ground[2] - camera[2],
    );
    if (away > atlas.drawDistance) continue;
    // 遠方は 1 つおき。`id` の偶奇で決めるので、近づくにつれ増えるだけで
    // 木が「入れ替わる」ようなちらつきは起きない
    if (atlas.thinBeyond !== undefined && away > atlas.thinBeyond && object.id % 2 === 1) continue;

    const art = artSize(object);
    sprites.push({
      id: `scenery-${generation}-${object.id}`,
      position: [ground[0], ground[1] + art.height / 2, ground[2]],
      size: [art.width, art.height],
      color: atlas.color,
      texture: atlas.url,
      cell: sceneryCell(atlas.layout, object),
      billboard: 'cylindrical',
      alphaCutoff: 0.5,
      ...(options.depthWrite === undefined ? {} : { depthWrite: options.depthWrite }),
      ...(options.orderTableIndex === undefined
        ? {}
        : { orderTableIndex: options.orderTableIndex as SpriteCommand['orderTableIndex'] }),
      generations: [generation],
    });
  }

  return sprites;
}
