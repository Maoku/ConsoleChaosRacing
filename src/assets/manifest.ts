import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  type RenderAssetManifest,
  type RenderModelAsset,
  type RenderTextureAsset,
} from '@console-chaos/engine';

import { BACKDROPS } from '../game/view/shared/backdrop.js';
import {
  CAR_LAMPS,
  CAR_MODELS,
  CAR_WHEELS,
  carTextureFor,
  carWheelAsset,
} from '../game/view/shared/car-model.js';
import {
  CAR_SPRITE_GEOMETRY,
  CAR_SPRITE_SOURCES,
} from '../game/view/shared/car-sprite.js';
import {
  COCKPIT_ATLAS,
  WHEEL_ATLAS,
  cockpitAvailable,
} from '../game/view/shared/cockpit.js';
import { ENVIRONMENT_MAP, SKYLINE } from '../game/view/shared/environment.js';
import { FONT_ATLAS, LOGO_ATLAS } from '../game/view/shared/font.js';
import { MARKER_ATLAS } from '../game/view/shared/minimap-layout.js';
import { SFC_ROAD_MAP } from '../game/view/shared/road-map.js';
import { ROAD_SURFACES } from '../game/view/shared/road-surface.js';
import { TYRE_WALL, TYRE_WALLS } from '../game/view/shared/scenery-mesh.js';
import { SCENERY_BILLBOARDS, SCENERY_SPRITES } from '../game/view/shared/scenery-sprite.js';
import { TACHO_ATLAS, TACHOMETERS } from '../game/view/shared/tachometer.js';
import {
  TRACK_MESH_LODS,
  trackSectorAsset,
  trackSurfaceTexture,
} from '../game/view/shared/track-mesh.js';
import {
  tunnelAsset,
  tunnelLampAsset,
  tunnelTexture,
} from '../game/view/shared/tunnel.js';

/**
 * 車のテクスチャもテーブルから導く。塗装テクスチャは無彩色 1 枚で全車が共有し、
 * 車体色は `MeshCommand.color` の乗算で決まる（`car-model.ts` の `CAR_PAINT`）。
 */
const carTextures: RenderTextureAsset[] = GENERATION_IDS.flatMap((generation) => {
  if (!CAR_MODELS[generation]) return [];
  // メッシュが参照するテクスチャなので flipY: false（下の textures のコメントを参照）
  return [{ url: carTextureFor(generation), wrap: 'clamp' as const, flipY: false }];
});

/**
 * 車のメッシュ（フェーズ 12-7）。1 台は**車体・車輪・灯火の 3 つ**でできている。
 *
 * 車輪は位相ぶん（`CAR_WHEELS.phases` 枚）並ぶので、ここも表から導く。
 * 枚数を変えたときに manifest の書き換えを忘れる事故を構造的に無くす。
 * `polygonSort` はコースと同じく**能力から決める** — 深度バッファの無い世代だけが
 * 三角形単位の並べ替えを要る（第3世代の車体と車輪はマテリアル側でも有効にする）。
 */
const carModels: RenderModelAsset[] = GENERATION_IDS.flatMap((generation) => {
  const model = CAR_MODELS[generation];
  if (!model) return [];
  const needsPolygonSort = !HARDWARE_GENERATION_PROFILES[generation].video.depthBuffer;
  const sort = needsPolygonSort ? { polygonSort: true } : {};
  const wheels = CAR_WHEELS[generation];
  const lamps = CAR_LAMPS[generation];
  return [
    { url: model.asset, ...sort },
    ...(wheels
      ? Array.from({ length: wheels.phases }, (_unused, phase) => ({
          url: carWheelAsset(generation, phase),
          ...sort,
        }))
      : []),
    ...(lamps ? [{ url: lamps.asset, ...sort }] : []),
  ];
});

/**
 * コースメッシュの登録は LOD テーブルから導く。セクター数を変えたときに
 * manifest の書き換えを忘れる、という事故を構造的に無くす。
 *
 * `polygonSort` は**能力から決める**。三角形単位の安定ソートは深度バッファの無い
 * 世代のための仕組みで、有効にするとモデルごとにソート用の作業配列が確保される。
 * 深度バッファを持つ世代（第4世代）では走査すらされないので、無駄に確保しない。
 */
const trackModels: RenderModelAsset[] = GENERATION_IDS.flatMap((generation) => {
  const lod = TRACK_MESH_LODS[generation];
  if (!lod) return [];
  const needsPolygonSort = !HARDWARE_GENERATION_PROFILES[generation].video.depthBuffer;
  return Array.from({ length: lod.sectorCount }, (_unused, sector) => ({
    url: trackSectorAsset(lod, sector),
    ...(needsPolygonSort ? { polygonSort: true } : {}),
  }));
});

/**
 * 擬似3D世代の路面テクスチャ（生成物 / tools/build-road-texture.mjs）。
 *
 * `clamp` なのは、コーナーの先で路面が画面外へ流れたとき端の草地が伸びるようにするため。
 * 第1世代は V を CPU 側で fract 済みなので縦の repeat も要らず、第2世代は
 * テクスチャ 1 枚が最遠の行の画面幅より広いので、そもそも端まで届かない。
 * 同梱の `road.png` / `circuit.png` を使わない理由は `road-surface.ts` の冒頭に書いた。
 */
const roadTextures: RenderTextureAsset[] = GENERATION_IDS.flatMap((generation) => {
  const layout = ROAD_SURFACES[generation];
  return layout ? [{ url: layout.texture, wrap: 'clamp' as const }] : [];
});

/**
 * 第2世代のコースマップ（生成物 / tools/build-road-map.mjs）。
 *
 * 帯ではなく**コース全体のトップダウン図**で、アフィン面の UV がワールド XZ の
 * 写像になる（`road-map.ts`）。`clamp` なのは外周の単色をコースの外へ伸ばすため —
 * 実機の「Mode 7 面の外はタイル 0 を敷く」設定に対応する。
 *
 * **`flipY: false` が要る。** v はワールド Z そのものなので、既定の `flipY: true` で
 * 取り込むとコースが Z 方向に鏡像になり、自機の足元に路面が来なくなる。
 * 帯テクスチャは v が模様の位相でしかなく、対称な繰り返しなので気付けなかった。
 */
const roadMapTexture: RenderTextureAsset = {
  url: SFC_ROAD_MAP.texture,
  wrap: 'clamp',
  flipY: false,
};

/** 遠景の層。第2世代だけ `tools/build-backdrop.mjs` の生成物を読む（8-2） */
const backdropTextures: RenderTextureAsset[] = GENERATION_IDS.flatMap((generation) => {
  const layout = BACKDROPS[generation];
  return layout ? [{ url: layout.texture, wrap: 'repeat' as const }] : [];
});

/**
 * 背景オブジェクトのアトラス（生成物 / tools/build-scenery-sprites.mjs・8-6）。
 * 擬似3D 世代はスクリーン空間、3D 世代はワールド空間のビルボードとして引く
 */
const sceneryAtlases = GENERATION_IDS.flatMap((generation) => {
  const atlas = SCENERY_SPRITES[generation] ?? SCENERY_BILLBOARDS[generation];
  // セルの並びはアトラスごとに違う（第4世代だけ 3×2 の 6 セル・8-10）
  return atlas
    ? [{ url: atlas.url, columns: atlas.layout.columns, rows: atlas.layout.rows }]
    : [];
});

/** タイヤフェンス（生成物 / tools/build-scenery-mesh.mjs・8-6）。第4世代だけが置く */
const tyreWallModels: RenderModelAsset[] = GENERATION_IDS.some(
  (generation) => TYRE_WALLS[generation] !== null,
)
  ? [{ url: TYRE_WALL.asset }]
  : [];

/** タコメーターのアトラス（生成物 / tools/build-gauge.mjs）。FC / SFC は持たない */
const tachometerAtlases = GENERATION_IDS.flatMap((generation) => {
  const layout = TACHOMETERS[generation];
  return layout
    ? [{ url: layout.url, columns: TACHO_ATLAS.columns, rows: TACHO_ATLAS.rows }]
    : [];
});

/**
 * 内装とステアリング（生成物 / tools/build-cockpit.mjs）。
 * 視点の表（`CAMERA_VIEWS`）に `cockpit` を持つ世代だけが読む
 */
const cockpitAtlases = GENERATION_IDS.some((generation) => cockpitAvailable(generation))
  ? [
      { url: COCKPIT_ATLAS.url, columns: COCKPIT_ATLAS.columns, rows: COCKPIT_ATLAS.rows },
      { url: WHEEL_ATLAS.url, columns: WHEEL_ATLAS.columns, rows: WHEEL_ATLAS.rows },
    ]
  : [];

const trackTextures: RenderTextureAsset[] = GENERATION_IDS.flatMap((generation) => {
  const lod = TRACK_MESH_LODS[generation];
  if (!lod) return [];
  // v 方向に周回ぶんタイルするので repeat。u は帯の内側に収めてある。
  // flipY: false はメッシュのテクスチャ共通の規約（下の textures のコメントを参照）
  return [
    { url: trackSurfaceTexture(lod), wrap: 'repeat' as const, flipY: false },
    // トンネル（生成物 / tools/build-tunnel-mesh.mjs・8-9）。躯体と灯具が共有する
    { url: tunnelTexture(lod), wrap: 'repeat' as const, flipY: false },
  ];
});

/**
 * トンネルの躯体と灯具（生成物 / tools/build-tunnel-mesh.mjs・8-9）。
 *
 * 2 つに分けてあるのはマテリアルを分けるためで、灯具だけは環境光が落ちても
 * 明るいままにする。第3世代は深度バッファが無いので、路面と同じ
 * `polygonSort` を掛けて三角形単位に分配する。
 */
const tunnelModels: RenderModelAsset[] = GENERATION_IDS.flatMap((generation) => {
  const lod = TRACK_MESH_LODS[generation];
  if (!lod) return [];
  const needsPolygonSort = !HARDWARE_GENERATION_PROFILES[generation].video.depthBuffer;
  const sort = needsPolygonSort ? { polygonSort: true } : {};
  return [
    { url: tunnelAsset(lod), ...sort },
    { url: tunnelLampAsset(lod), ...sort },
  ];
});

/**
 * レンダラーへ渡すアセット目録（実装計画 付録 B）。
 *
 * 規約:
 * - スプライトとして描く画像は `atlases` にだけ登録する。レンダラーは atlas の URL も
 *   画像として読み込み `flipY:false` / `wrap:'clamp'` を強制するため、`textures` への
 *   二重登録は無意味（`textures` 側の指定は無視される）。
 * - `textures` に載せるのは背景・マテリアル・サーフェスが参照するものだけ。
 * - 生成物（font / logo / markers / minimap / track）は、生成したフェーズで追加する。
 *   `manifest.spec.ts` が全 URL の実在を検査するため、先に書くとテストが落ちる。
 */
export const MANIFEST: RenderAssetManifest = {
  textures: [
    { url: 'assets/common/fallback.png', wrap: 'clamp' },
    ...roadTextures,
    roadMapTexture,
    // 遠景の層。第2世代は BG スペックへ寄せた生成物のほうを読む（8-2）
    ...backdropTextures,
    // **メッシュが参照するテクスチャは必ず `flipY: false`。**
    // glTF の UV は v = 0 が画像の上端だが、レンダラーは `textures` を既定 `flipY: true` で
    // 取り込む（アトラスだけは false を強制する）。指定を忘れると上下逆に貼られ、
    // 車体が迷彩柄のようになる。`frame-contract.spec.ts` がこの規約を検査する。
    ...carTextures,
    // 環境マップは映り込み（`equirectangularUv`）が v = 0 を真上とみなすので flipY: false。
    // 遠景の層は逆に「絵は反転済み」を前提にしているので、同じ 1 枚は使えない。
    // 地平線の帯を別ファイルへ焼き出してある（`shared/environment.ts` の表）
    { url: ENVIRONMENT_MAP.url, wrap: 'repeat', flipY: false },
    { url: SKYLINE.url, wrap: 'repeat' },
    ...trackTextures,
  ],
  atlases: [
    // 生成物（tools/build-car-sprites.mjs・フェーズ 3）。同梱の cars.png は
    // 絵がセル境界をはみ出しており、正面のセルに隣の車が写り込む
    // 行数は世代で違う（第2世代だけ 1 台 1 パレットの 8 行・11-1）ので、
    // 形は世代テーブルから引く
    ...CAR_SPRITE_SOURCES.map((source) => {
      const layout = CAR_SPRITE_GEOMETRY[source.generation]!;
      return { url: source.to, columns: layout.columns, rows: layout.rows };
    }),
    // 生成物（tools/build-scenery-sprites.mjs・フェーズ 8-6）。
    // 4 世代が同じ `sceneryObjects()` を読むが、擬似3D の 2 世代だけがスプライトで置く
    ...sceneryAtlases,
    // 生成物（tools/build-minimap.mjs・フェーズ 1）。
    // 丸 / 四角 / 塗りつぶし。色は SpriteCommand.color で付ける
    { url: MARKER_ATLAS.url, columns: MARKER_ATLAS.columns, rows: MARKER_ATLAS.rows },
    // 生成物（tools/build-font-atlas.mjs・フェーズ 7）。`OverlayCommand` は WebGL
    // レンダラーで描かれないので、HUD の文字はこのアトラスのスプライトで出す
    { url: FONT_ATLAS.url, columns: FONT_ATLAS.columns, rows: FONT_ATLAS.rows },
    // 生成物（tools/build-title-logo.mjs・フェーズ 7）。1 枚で 4 世代ぶんを賄う
    { url: LOGO_ATLAS.url, columns: LOGO_ATLAS.columns, rows: LOGO_ATLAS.rows },
    { url: 'assets/gen1/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen2/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen3/hud/minimap.png', columns: 1, rows: 1 },
    { url: 'assets/gen4/hud/minimap.png', columns: 1, rows: 1 },
    // 生成物（tools/build-gauge.mjs・フェーズ 8-3）。第3・第4世代だけが持つ。
    // アナログのメーターは 3D 世代の HUD の作法で、出ないこと自体が世代差になる
    ...tachometerAtlases,
    // 生成物（tools/build-cockpit.mjs・フェーズ 8-5）。内装は第4世代だけが持つ
    ...cockpitAtlases,
  ],
  models: [
    ...carModels,
    ...trackModels,
    ...tunnelModels,
    // 生成物（tools/build-scenery-mesh.mjs・8-6）。置くのは第4世代だけ
    ...tyreWallModels,
  ],
  geometries: [
    { kind: 'box', halfExtents: [0.5, 0.5, 0.5] },
    { kind: 'quad', halfSize: [1, 1] },
  ],
  fallbackTextures: {
    FC: 'assets/common/fallback.png',
    SFC: 'assets/common/fallback.png',
    PS1: 'assets/common/fallback.png',
    PS2: 'assets/common/fallback.png',
  },
};

/** manifest.spec.ts / 生成ツールが参照する、全アセット URL の平坦なリスト。 */
export function manifestUrls(manifest: RenderAssetManifest = MANIFEST): readonly string[] {
  return [
    ...manifest.textures.map((texture) => texture.url),
    ...manifest.atlases.map((atlas) => atlas.url),
    ...manifest.models.map((model) => model.url),
    ...new Set(Object.values(manifest.fallbackTextures)),
  ];
}
