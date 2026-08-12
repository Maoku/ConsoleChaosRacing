import {
  NO_ENTITY,
  createFlickerState,
  type Entity,
  type RasterSurfaceCommand,
  type RenderFrame,
} from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { backdropCommands } from './shared/backdrop.js';
import {
  carSpriteAtlasFor,
  carSpriteCommand,
  playerPlacement,
  rivalPlacements,
  scanlineItem,
  type CarPlacementOptions,
} from './shared/car-sprite.js';
import { buildMinimap, defaultMinimapRect } from './shared/minimap.js';
import { FC_CAMERA, createRoadView } from './shared/projection.js';
import { roadSurfaceFor } from './shared/road-surface.js';
import { pushSpritePlane, type SpriteEntry } from './shared/sprite-plane.js';
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

/** 遠景 `coast.png` の実寸 */
const BACKDROP = { texture: 'assets/gen1/backgrounds/coast.png', width: 512, height: 192 } as const;

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
  const player = display.cars[PLAYER_ENTRANT];
  if (!atlas || !layout || !player) return;

  const view = createRoadView({ profile, camera: FC_CAMERA, track, car: player, layout });
  const origin = track.sampleAt(player.s);

  // ── 空と遠景。自機の向きで視差が付き、前方の勾配で地平線が上下する
  for (const background of backdropCommands({
    generation,
    profile,
    view,
    texture: BACKDROP.texture,
    textureWidth: BACKDROP.width,
    textureHeight: BACKDROP.height,
    sky: generationValue(SKY_COLORS, generation),
    heading: origin.heading,
  })) {
    frame.backgrounds.push(background);
  }

  frame.rasterSurfaces.push(buildRoadSurface(view, generation));

  // ── スプライト。登録順（＝優先度）は 自機 → ミニマップのマーカー → ライバル車
  const placement: CarPlacementOptions = { view, track, profile, atlas };
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
    ...scanlineItem(playerSprite, atlas.player, player.entrant),
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
    entries.push({ ...scanlineItem(sprite, atlas.rival, rival.entrant), sprites: [sprite] });
  }

  // 走査線制限・重ね順・BG 相当の扱いは `sprite-plane.ts` に集約してある。
  // ミニマップの枠だけは BG 相当なので制限の外に置き、最背面へ回す
  const culled = pushSpritePlane(frame, {
    profile,
    entries,
    background: [minimap.panelSprite],
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
): RasterSurfaceCommand {
  const top = view.camera.roadTopRow;
  const rows = view.screenHeight - top;
  const scanlines = new Float32Array(rows * 4);

  for (let index = 0; index < rows; index++) {
    // シェーダは行の中心でテーブルを引く。距離も画素の中心で求める
    const distance = view.distanceAtRow(top + index + 0.5);
    const depth = Math.min(1, distance / view.maxDistance);
    const stripe = index % 2 === 0 ? 1 : 1 - SCANLINE_STRIPE * (1 - depth);
    const shade = (1 - DEPTH_SHADE * depth) * stripe;

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
