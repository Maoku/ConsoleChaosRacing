import { NO_ENTITY, type RenderFrame, type SpriteCommand } from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { affineBandRows, affineRoadBands } from './shared/affine-surface.js';
import { backdropCommands, backdropFor } from './shared/backdrop.js';
import {
  carSpriteAtlasFor,
  carSpriteCommand,
  playerPlacement,
  rivalPlacements,
  scanlineItem,
  type CarPlacementOptions,
  type CarSpritePlacement,
} from './shared/car-sprite.js';
import { buildHud } from './shared/hud.js';
import { MARKER_ATLAS } from './shared/minimap-layout.js';
import { buildMinimap, defaultMinimapRect } from './shared/minimap.js';
import { SFC_CAMERA, SFC_DRAW_DISTANCE, createRoadView, type RoadView } from './shared/projection.js';
import { roadSurfaceFor } from './shared/road-surface.js';
import { pushSpritePlane, type SpriteEntry } from './shared/sprite-plane.js';
import { PLAYER_ENTRANT, SKY_COLORS, generationValue, rgb01 } from './shared/variants.js';

/**
 * 第2世代（SFC）— アフィン変換による擬似3D（実装計画 §3.3）。
 *
 * レンダラーが自動でやること: 256×224 / RGB555 への量子化 / composite の CRT。
 * 第1世代と同じ解像度・同じ投影・同じスプライト経路を使いながら、
 * **ハードウェアの差だけで別物に見える**ことがこの世代の主張になる。差は 4 つ。
 *
 * 1. **路面** — 走査線ごとの `AffineSurfaceCommand`。幅の制限が無いので
 *    描画距離が 98 m → 220 m に伸び、コーナーでは視界が傾く（`affine-surface.ts`）。
 * 2. **半透明** — `translucency: color-math`。落ち影とフォグの帯を実機の作法で出す。
 *    第2世代の半透明スプライトは**シーンへ直接**合成されるので、路面と本当に混ざる
 *    （不透明スプライトのほうは別面に描かれ、しきい値で上書き合成される）。
 * 3. **色** — 同時 256 色。路面の階調も遠景も第1世代より濃く作れる。
 * 4. **滑らかさ** — `tileSnap: 1` で座標を丸めず、更新レートは 12Hz。
 *    どちらも `carSpriteCommand` と `DisplayLatch` がプロファイルから決めるので、
 *    このファイルには「丸めない」というコードが 1 行も無い。
 */

/**
 * フォグの帯（実装計画 §6.1 第2世代基準 2「遠方がフォグで海に溶ける」）。
 *
 * アフィン面には第1世代の `brightness` にあたる項が無いので、遠方を霞ませるには
 * 上から重ねるしかない。color math の half は「半分だけ混ぜる」しか出せないため、
 * **距離ごとに帯を重ねて段階を作る** — k 枚重なった行は `1 - 0.5^k` だけ霞む。
 * 実機で階調を作るときの手口そのままで、composite の滲みが段差を均してくれる。
 */
const FOG_BANDS = [
  // 手前の帯ほど**路面に近い固定色**にする。half の重ねは背面を必ず半分にするので、
  // 固定色まで空の色にすると 40 m 先が一段で白む。実機も HDMA で固定色そのものを
  // 走査線ごとに書き換えており、これはその作法に対応する
  { distance: 40, color: '#607068' },
  { distance: 60, color: '#789098' },
  { distance: 90, color: '#88b0c8' },
  // 最遠は遠景の海と空の境目の色。ここで路面が背景へ溶ける
  { distance: 150, color: '#88b8d8' },
] as const;

/** 落ち影。color math の subtract half ＝ 路面を半分に落として少し引く */
const SHADOW_COLOR = '#181820';
/** 影の大きさ（セルの一辺に対する比）と、接地点からの潰れ具合 */
const SHADOW_WIDTH = 0.42;
const SHADOW_FLATTEN = 0.3;

/**
 * ライバルを描く上限距離 [m]。
 * これより奥はフォグが 8 割を超えるうえ、スプライトが 5 px を切って点にしかならない。
 */
const RIVAL_DRAW_DISTANCE = 150;

export function buildGen2View(frame: RenderFrame, context: ViewContext): void {
  const { generation, profile, state, display } = context;
  const track = state.track;
  const atlas = carSpriteAtlasFor(generation);
  const layout = roadSurfaceFor(generation);
  const backdrop = backdropFor(generation);
  const player = display.cars[PLAYER_ENTRANT];
  if (!atlas || !layout || !backdrop || !player) return;

  const view = createRoadView({
    profile,
    camera: SFC_CAMERA,
    track,
    car: player,
    layout,
    maxDistance: SFC_DRAW_DISTANCE,
  });
  const origin = track.sampleAt(view.originS);

  // ── 空と遠景。第1世代とまったく同じ関数を通す（違うのはテクスチャと色だけ）
  for (const background of backdropCommands({
    generation,
    profile,
    view,
    texture: backdrop.texture,
    textureWidth: backdrop.width,
    textureHeight: backdrop.height,
    sky: generationValue(SKY_COLORS, generation),
    heading: origin.heading,
  })) {
    frame.backgrounds.push(background);
  }

  // ── 路面。走査線ごとに 1 枚のアフィン面（実機の HDMA と同じ粒度）
  for (const band of affineRoadBands({
    generation,
    view,
    bandRows: affineBandRows(context.renderedGenerations),
  })) {
    frame.affineSurfaces.push(band);
  }

  // ── フォグ。半透明スプライトはシーンへ直接合成されるので、
  // 車（不透明・別面）より奥に入る。積む順は手前の帯から
  for (const band of fogBands(view, generation)) frame.sprites.push(band);

  // ── スプライト。登録順（＝優先度）は 自機 → ミニマップのマーカー → ライバル車
  const placement: CarPlacementOptions = {
    view,
    track,
    profile,
    generation,
    atlas,
    farClip: RIVAL_DRAW_DISTANCE,
  };
  const minimap = buildMinimap({
    generation,
    profile,
    track,
    cars: display.cars,
    rect: defaultMinimapRect(generation, profile),
    frameIndex: display.frameIndex,
  });

  const entries: SpriteEntry[] = [];
  entries.push(carEntry(playerPlacement(placement, player), placement, generation));

  minimap.markerSpriteGroups.forEach((sprites, index) => {
    const marker = minimap.markers[index]!;
    entries.push({
      entity: NO_ENTITY,
      y: marker.position[1] - marker.size / 2,
      height: marker.size,
      sprites,
    });
  });

  for (const rival of rivalPlacements(placement, display.cars, player)) {
    entries.push(carEntry(rival, placement, generation));
  }

  // 32 スプライト/走査線なので実質かからないが、契約は同じように守る。
  // 枠と HUD は BG 相当なので制限の外（§3.6）
  const hud = buildHud({ generation, profile, display, screen: context.screen });
  pushSpritePlane(frame, {
    profile,
    entries,
    background: [minimap.panelSprite],
    foreground: hud.sprites,
  });
}

/** 1 台ぶん — 落ち影とスプライト本体。落ちるときは影ごと落ちる */
function carEntry(
  placement: CarSpritePlacement,
  options: CarPlacementOptions,
  generation: ViewContext['generation'],
): SpriteEntry {
  const sprite = carSpriteCommand(placement, options.atlas, options.profile, generation);
  const row = placement.isPlayer ? options.atlas.player : options.atlas.rival;
  return {
    ...scanlineItem(sprite, row, placement.entrant),
    sprites: [shadowSprite(placement, options, generation), sprite],
  };
}

/**
 * 落ち影（§6.1 第2世代基準 3）。
 *
 * `subtract` + `half` は実機の color math そのもので、背面を半分に落としてから
 * 影の色を引く。**第1世代には無い表現**であり、同じスプライトを同じ位置に置いても
 * 接地しているかどうかがこの 1 枚で変わる。
 */
function shadowSprite(
  placement: CarSpritePlacement,
  options: CarPlacementOptions,
  generation: ViewContext['generation'],
): SpriteCommand {
  const row = placement.isPlayer ? options.atlas.player : options.atlas.rival;
  const ground = placement.position[1] + (row.groundFraction - 0.5) * placement.size;
  const width = placement.size * SHADOW_WIDTH;
  return {
    id: `car-shadow-${generation}-${placement.entrant}`,
    screenSpace: true,
    position: [placement.position[0], ground - (width * SHADOW_FLATTEN) / 2, 0],
    size: [width, width * SHADOW_FLATTEN],
    color: SHADOW_COLOR,
    texture: MARKER_ATLAS.url,
    cell: MARKER_ATLAS.cells.rival,
    alphaCutoff: 0.5,
    layer: 15,
    hardwareBlend: { family: 'gen2-color-math', operation: 'subtract', half: true },
    generations: [generation],
  };
}

/** 遠方ほど厚く重なるフォグの帯。各帯は路面帯の上端から `distance` の行まで */
function fogBands(view: RoadView, generation: ViewContext['generation']): SpriteCommand[] {
  const top = view.camera.roadTopRow;
  const bands: SpriteCommand[] = [];

  for (const [index, band] of FOG_BANDS.entries()) {
    const bottom = Math.round(view.rowAtDistance(band.distance));
    const height = bottom - top;
    if (height < 1) continue;
    bands.push({
      id: `road-fog-${generation}-${index}`,
      screenSpace: true,
      position: [view.screenWidth / 2, top + height / 2, 0],
      size: [view.screenWidth, height],
      color: band.color,
      texture: MARKER_ATLAS.url,
      cell: MARKER_ATLAS.cells.fill,
      layer: 10,
      // 固定色との加算 half。実機の「固定色 color math」に対応する
      hardwareBlend: {
        family: 'gen2-color-math',
        operation: 'add',
        half: true,
        operand: 'fixed',
        fixedColor: rgb01(band.color),
      },
      generations: [generation],
    });
  }

  // 帯どうしの重なりは順序に依らない（どの順でも `1 - 0.5^k` に落ち着く）
  return bands;
}
