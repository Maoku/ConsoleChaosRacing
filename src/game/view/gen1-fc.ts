import {
  NO_ENTITY,
  createFlickerState,
  type Entity,
  type RasterSurfaceCommand,
  type RenderFrame,
} from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { backdropCommands, backdropFor } from './shared/backdrop.js';
import {
  carSpriteAtlasFor,
  carSpriteCommand,
  carSpriteRow,
  playerPlacement,
  rivalPlacements,
  scanlineItem,
  type CarPlacementOptions,
} from './shared/car-sprite.js';
import { buildHud } from './shared/hud.js';
import { buildMinimap, defaultMinimapRect } from './shared/minimap.js';
import { FC_CAMERA, createRoadView } from './shared/projection.js';
import { roadSurfaceFor } from './shared/road-surface.js';
import { sceneryFor } from './shared/scenery.js';
import { scenerySpriteAtlasFor, sceneryPlacements } from './shared/scenery-sprite.js';
import { pushSpritePlane, type SpriteEntry } from './shared/sprite-plane.js';
import {
  TUNNEL_ROAD_SHADE,
  tunnelScreen,
  type TunnelScreen,
} from './shared/tunnel-sprite.js';
import { PLAYER_ENTRANT, SKY_COLORS, generationValue } from './shared/variants.js';

/**
 * 第1世代（FC）— ラスタースクロールによる擬似3D（実装計画 §3.2）。
 *
 * レンダラーが自動でやること: 256×224 / 54 色パレットへの量子化 / RF の強い CRT。
 * ゲーム側が受け持つのは次の 4 つで、どれも**自動では強制されない能力契約**（§1.4）。
 *
 * 1. 路面 — `RasterSurfaceCommand` を 1 枚。走査線ごとに
 *    「テクスチャの U 中心・U 幅・V 位相・明るさ」を書き込む。**これが表現の中心**で、
 *    曲率も速度も勾配もこの 4 値だけで出る。
 * 2. 色 — 同時 25 色。半透明（`hardwareBlend`）を 1 つも積まず、明るさの段数も抑える。
 * 3. 8 px グリッド — 遠景のスクロール量とスプライトの配置座標を丸める（`tileSnap`）。
 *    ミニマップのマーカーだけは実機の OAM に倣って 1 px 単位に置く（§3.6）。
 * 4. 走査線 8 スプライト — `applyScanlineLimit` で超過分を落とす。
 *    自機を必ず先頭に登録し、マーカーはフレームごとに順序を巡回させてちらつかせる。
 */

/** 明るさの段数。連続に振ると量子化後の色数が増えるので 16 段に丸める */
const BRIGHTNESS_STEPS = 16;
/** 最遠でどれだけ暗くするか。FC にフォグは無いが、階調だけで奥行きが出る */
const DEPTH_SHADE = 0.16;
/** 走査線の縞。奇数行をわずかに落とす */
const SCANLINE_STRIPE = 0.06;

/**
 * 走査線制限で落ちたスプライト（実装計画 §3.2）。
 *
 * **シムへは戻していない。** 戻すと世代によってシムの状態が変わり、
 * 「どの世代へ切り替えても順位・周回・位置が完全に保存される」（§6.1 世代横断 1）と
 * `generation-invariance.spec.ts` が壊れる。落ちた車の記録だけをここに残し、
 * 当たり判定へ効かせるかどうかは判定を持つ側の判断に委ねる。
 */
const flicker = createFlickerState();

/** 直前のフレームで走査線制限に落ちたエントラント。テストと将来の当たり判定用 */
export function culledEntrants(): ReadonlySet<Entity> {
  return flicker.state.culled;
}

export function buildGen1View(frame: RenderFrame, context: ViewContext): void {
  const { generation, profile, state, display } = context;
  const track = state.track;
  const atlas = carSpriteAtlasFor(generation);
  const layout = roadSurfaceFor(generation);
  const backdrop = backdropFor(generation);
  const scenery = scenerySpriteAtlasFor(generation);
  const player = display.cars[PLAYER_ENTRANT];
  if (!atlas || !layout || !backdrop || !player) return;

  const view = createRoadView({ profile, camera: FC_CAMERA, track, car: player, layout });
  const origin = track.sampleAt(player.s);

  // ── 空と遠景。自機の向きで視差が付き、前方の勾配で地平線が上下する
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

  // ── トンネル（8-9）。走査線の明るさと、坑口の矩形 3 枚だけで出す
  const tunnel = tunnelScreen({ generation, profile, track, view });
  frame.rasterSurfaces.push(buildRoadSurface(view, generation, tunnel));

  // ── スプライト。登録順（＝優先度）は 自機 → ミニマップのマーカー → ライバル車
  const placement: CarPlacementOptions = { view, track, profile, generation, atlas };
  const minimap = buildMinimap({
    generation,
    profile,
    track,
    cars: display.cars,
    rect: defaultMinimapRect(generation, profile),
    frameIndex: display.frameIndex,
  });

  // 登録順が優先度。自機を先頭に置くので、自機だけは決して消えない
  const entries: SpriteEntry[] = [];

  const playerSprite = carSpriteCommand(
    playerPlacement(placement, player),
    atlas,
    profile,
    generation,
  );
  entries.push({
    ...scanlineItem(playerSprite, carSpriteRow(atlas, player.entrant), player.entrant),
    sprites: [playerSprite],
  });

  // マーカーは実機でもスプライトだったので制限の対象に含める。ただし
  // 当たり判定には関係しないので NO_ENTITY で登録する（§3.6）
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
    const sprite = carSpriteCommand(rival, atlas, profile, generation);
    entries.push({
      ...scanlineItem(sprite, carSpriteRow(atlas, rival.entrant), rival.entrant),
      sprites: [sprite],
    });
  }

  // 背景オブジェクト（8-6）は**いちばん後ろに登録する** ＝ 走査線が混んだときに
  // 最初に消えるのが背景になる。第1世代は 8 スプライト/走査線なので看板 1 種だけ
  if (scenery) {
    for (const placed of sceneryPlacements({
      generation,
      profile,
      view,
      track,
      objects: sceneryFor(track),
      atlas: scenery,
      farClip: tunnel.sceneryClip,
    })) {
      entries.push({
        entity: NO_ENTITY,
        y: placed.y,
        height: placed.height,
        sprites: [placed.sprite],
      });
    }
  }

  // 走査線制限・重ね順・BG 相当の扱いは `sprite-plane.ts` に集約してある。
  // 坑口の壁・ミニマップの枠・HUD の文字はどれも実機なら BG タイル面のもので、
  // スプライト枠を消費しない。壁と枠は最背面（壁が枠の後ろ）、HUD は最前面
  // （実機の BG 面も優先度ビットでスプライトの前後どちらにも置けた）
  const hud = buildHud({ generation, profile, display, screen: context.screen });
  const culled = pushSpritePlane(frame, {
    profile,
    entries,
    background: [...tunnel.panels, minimap.panelSprite],
    foreground: hud.sprites,
  });
  flicker.commit(culled);
}

/**
 * 路面のラスターサーフェス（実装計画 §3.2）。
 *
 * 走査線 1 本につき 4 値。`validateRasterSurface` が
 * 「`width ∈ (0, 1]`・`brightness ∈ [0, 1]`・`scanlines.length === height * 4`」を強制し、
 * 外れると実行時に throw する。`raster-scanline.spec.ts` が事前に検出する。
 */
function buildRoadSurface(
  view: ReturnType<typeof createRoadView>,
  generation: ViewContext['generation'],
  tunnel: TunnelScreen,
): RasterSurfaceCommand {
  const top = view.camera.roadTopRow;
  const rows = view.screenHeight - top;
  const scanlines = new Float32Array(rows * 4);

  for (let index = 0; index < rows; index++) {
    // シェーダは行の中心でテーブルを引く。距離も画素の中心で求める
    const row = top + index + 0.5;
    const distance = view.distanceAtRow(row);
    const depth = Math.min(1, distance / view.maxDistance);
    const stripe = index % 2 === 0 ? 1 : 1 - SCANLINE_STRIPE * (1 - depth);
    // トンネルの中を映している行は**明るさをまるごと差し替える**（8-9）。
    // 走査線ごとにパレットを差し替えていた実機の作法そのもので、
    // メッシュを 1 つも足さずに済む。奥行きの階調と縞を掛けないのは、
    // 量子化の落ち先が行ごとに揺れて路面が縞に割れるため（`TUNNEL_ROAD_SHADE`）
    const shade = tunnel.shadedRow(row)
      ? TUNNEL_ROAD_SHADE
      : (1 - DEPTH_SHADE * depth) * stripe;

    const offset = index * 4;
    scanlines[offset] = view.sourceCenterAt(distance);
    scanlines[offset + 1] = view.sourceWidthAt(distance);
    scanlines[offset + 2] = view.sourceVAt(distance);
    scanlines[offset + 3] = Math.round(shade * BRIGHTNESS_STEPS) / BRIGHTNESS_STEPS;
  }

  return {
    id: `road-${generation}`,
    texture: view.layout.texture,
    screenRect: [0, top, view.screenWidth, rows],
    scanlines,
    generations: [generation],
  };
}
