import {
  defineGenerationVariant,
  generationValue,
  type CameraCommand,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type MaterialCommand,
  type MeshCommand,
  type RenderFrame,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { CarState, RaceState } from '../../sim/state.js';
import {
  BILLBOARD_GEOMETRY,
  billboardBox,
  billboardFrame,
  enclosingDistance,
  type BillboardCamera,
} from './billboard.js';
import {
  MINIMAP_LAYOUTS,
  minimapNormalized,
  minimapPoint,
  minimapProjection,
  type MinimapLayout,
  type MinimapProjection,
  type MinimapRect,
} from './minimap-layout.js';
import { ENTRANT_COLORS, PLAYER_ENTRANT, supportsScreenSprites } from './variants.js';

/**
 * ミニマップ — 4 世代の下に共通して敷かれる 5 番目のビュー（実装計画 §3.6）。
 *
 * プレイヤーへの情報提供に加えて、**4 世代が 1 つのシミュレーションで動いていることを
 * 画面上で証明する**装置として扱う。マーカーの位置は 4 世代とも
 * `track.toWorld()` → `minimapPoint()` というまったく同じ 1 本の計算で決まり、
 * 世代差は矩形・寸法・色、そして描画の手段だけである。
 *
 * **描画の手段が 2 通りあるのはエンジンの実測結果による**（`billboard.ts` の注記）。
 * スプライトはパレット量子化のある世代（FC / SFC）にしか描かれないので、
 * 真色世代（PS1 / PS2）ではカメラ前面の板メッシュで同じ矩形を埋める。
 * 分岐は世代 ID ではなく `profile.video.paletteMode` から導く能力判定で行う。
 */

const MINIMAP_TEXTURES: GenerationVariant<string> = defineGenerationVariant({
  FC: 'assets/gen1/hud/minimap.png',
  SFC: 'assets/gen2/hud/minimap.png',
  PS1: 'assets/gen3/hud/minimap.png',
  PS2: 'assets/gen4/hud/minimap.png',
});

/** スプライト経路のアトラス。0 = 丸（ライバル）、1 = 四角（自機） */
const MARKER_ATLAS = 'assets/common/markers.png';
const MARKER_CELL = { rival: 0, player: 1 } as const;

/** 板メッシュ経路のテクスチャ（メッシュはアトラスのセルを選べない） */
const MARKER_TEXTURES = {
  rival: 'assets/common/marker-round.png',
  player: 'assets/common/marker-square.png',
} as const;

/** 板をカメラの何メートル前に置くか。near(0.1) より十分遠く、コースより十分近い */
const BILLBOARD_DISTANCE = 3;

interface MarkerStyle {
  /** 順位に応じた色を使うか。偽なら自機／他車の 2 色だけ */
  readonly useStandingColors: boolean;
  readonly playerColor: string;
  readonly rivalColor: string;
  /** マーカーの落ち影を置くか */
  readonly shadow: boolean;
  /** 自機に強調の縁を置くか */
  readonly playerRing: boolean;
}

/**
 * 色数の制約がそのままマーカーの情報量になる。
 * FC は 25 色しか置けないので自機と他車の 2 色だけ、PS2 は順位色に強調縁まで載る。
 */
const MARKER_STYLES: GenerationVariant<MarkerStyle> = defineGenerationVariant({
  FC: {
    useStandingColors: false,
    playerColor: '#fcfcfc',
    rivalColor: '#787878',
    shadow: false,
    playerRing: false,
  },
  SFC: {
    useStandingColors: false,
    playerColor: '#f8f800',
    rivalColor: '#e85820',
    shadow: true,
    playerRing: false,
  },
  PS1: {
    useStandingColors: true,
    playerColor: '#f8d800',
    rivalColor: '#98a8c0',
    shadow: true,
    playerRing: false,
  },
  PS2: {
    useStandingColors: true,
    playerColor: '#f8d800',
    rivalColor: '#98a8c0',
    shadow: true,
    playerRing: true,
  },
});

/** 順位色。1 位から順に金・銀・銅、それ以降はエントラント固有色 */
const STANDING_COLORS = ['#f8d800', '#d0d8e0', '#c07038'] as const;

export interface MinimapMarker {
  readonly entrant: number;
  /** 0..1 の正規化座標。**4 世代で完全に一致する** */
  readonly normalized: readonly [number, number];
  /** 内部解像度の画素座標（マーカーの中心） */
  readonly position: readonly [number, number];
  /** 一辺 [px] */
  readonly size: number;
  readonly color: string;
  readonly isPlayer: boolean;
}

export interface MinimapView {
  readonly layout: MinimapLayout;
  readonly projection: MinimapProjection;
  readonly rect: MinimapRect;
  /** 登録順（自機が先頭）。FC の走査線制限はこの順に効く */
  readonly markers: readonly MinimapMarker[];
  /** スプライト経路の成果物。板メッシュ経路では空 */
  readonly sprites: readonly SpriteCommand[];
  /** 板メッシュ経路の成果物。スプライト経路では空 */
  readonly meshes: readonly MeshCommand[];
  readonly materials: readonly MaterialCommand[];
}

export interface MinimapOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly state: RaceState;
  readonly rect: MinimapRect;
  /**
   * 量子化済みのフレーム番号。マーカーの登録順を毎フレーム巡回させるのに使う
   * （実機の OAM ローテーションと同じ手法。密集しても消えっぱなしにならない）
   */
  readonly frameIndex?: number;
  readonly layer?: number;
  /**
   * 板メッシュ経路で必要になるカメラ。スプライトが描かれない世代で省くと、
   * ミニマップは何も積まれない（描けないことを黙って隠さない）
   */
  readonly camera?: CameraCommand;
}

function markerColor(car: CarState, style: MarkerStyle): string {
  if (car.entrant === PLAYER_ENTRANT) return style.playerColor;
  if (!style.useStandingColors) return style.rivalColor;
  const podium = STANDING_COLORS[car.standing - 1];
  return podium ?? ENTRANT_COLORS[car.entrant % ENTRANT_COLORS.length] ?? style.rivalColor;
}

/**
 * 登録順を決める。自機を必ず先頭に置いて消えないようにし、
 * ライバルのマーカーはフレームごとに順序を巡回させる（実装計画 §3.6）。
 */
function registrationOrder(state: RaceState, frameIndex: number): CarState[] {
  const player = state.cars[PLAYER_ENTRANT];
  const rivals = state.cars.filter((car) => car.entrant !== PLAYER_ENTRANT);
  const rotation = rivals.length > 0 ? frameIndex % rivals.length : 0;
  const ordered: CarState[] = [];
  if (player) ordered.push(player);
  for (let index = 0; index < rivals.length; index++) {
    ordered.push(rivals[(index + rotation) % rivals.length]!);
  }
  return ordered;
}

/**
 * ミニマップを組み立てる。フレームへは積まない（テストが純関数として検査できる）。
 */
export function buildMinimap(options: MinimapOptions): MinimapView {
  const { generation, profile, state, rect } = options;
  const layout = generationValue(MINIMAP_LAYOUTS, generation);
  const style = generationValue(MARKER_STYLES, generation);
  const texture = generationValue(MINIMAP_TEXTURES, generation);
  const projection = minimapProjection(state.track.bounds, rect, layout.margin);
  const layer = options.layer ?? 40;
  const markerScale = Math.max(1, layout.markerSize * (rect.width / layout.size));

  // ── 4 世代で共通の部分: どこに何を置くか
  const markers: MinimapMarker[] = [];
  for (const car of registrationOrder(state, options.frameIndex ?? 0)) {
    const world = state.track.toWorld(car.s, car.lateral);
    const normalized = minimapNormalized(state.track.bounds, world[0], world[2]);
    const [x, y] = minimapPoint(projection, world[0], world[2]);
    const isPlayer = car.entrant === PLAYER_ENTRANT;
    markers.push({
      entrant: car.entrant,
      normalized,
      position: [x, y],
      size: isPlayer ? markerScale * 1.15 : markerScale,
      color: markerColor(car, style),
      isPlayer,
    });
  }

  // ── 世代で変わるのはここから先（描画の手段）だけ
  const shared = { layout, projection, rect, markers };
  return supportsScreenSprites(profile)
    ? { ...shared, ...spriteCommands(options, style, texture, markers, layer) }
    : { ...shared, ...billboardCommands(options, profile, style, texture, markers, layer) };
}

function spriteCommands(
  options: MinimapOptions,
  style: MarkerStyle,
  texture: string,
  markers: readonly MinimapMarker[],
  layer: number,
): Pick<MinimapView, 'sprites' | 'meshes' | 'materials'> {
  const { generation, rect } = options;
  const sprites: SpriteCommand[] = [
    {
      id: `minimap-panel-${generation}`,
      screenSpace: true,
      position: [rect.left + rect.width / 2, rect.top + rect.height / 2, 0],
      size: [rect.width, rect.height],
      color: '#ffffff',
      texture,
      cell: 0,
      // パネルの不透明度（最小 0.45）より下に置く。ここを上げると、半透明パネルが
      // まるごと discard されて枠が消える
      alphaCutoff: 0.02,
      layer,
      generations: [generation],
    },
  ];

  for (const marker of markers) {
    const [x, y] = marker.position;
    const cell = marker.isPlayer ? MARKER_CELL.player : MARKER_CELL.rival;
    if (style.playerRing && marker.isPlayer) {
      sprites.push({
        id: `minimap-ring-${generation}`,
        screenSpace: true,
        position: [x, y, 0],
        size: [marker.size * 1.9, marker.size * 1.9],
        color: '#ffffff',
        texture: MARKER_ATLAS,
        cell: MARKER_CELL.rival,
        alphaCutoff: 0.5,
        layer: layer + 1,
        generations: [generation],
      });
    }
    if (style.shadow) {
      sprites.push({
        id: `minimap-shadow-${generation}-${marker.entrant}`,
        screenSpace: true,
        position: [x + 1, y + 1, 0],
        size: [marker.size, marker.size],
        color: '#101018',
        texture: MARKER_ATLAS,
        cell,
        alphaCutoff: 0.5,
        layer: layer + 1,
        generations: [generation],
      });
    }
    sprites.push({
      id: `minimap-marker-${generation}-${marker.entrant}`,
      screenSpace: true,
      position: [x, y, 0],
      size: [marker.size, marker.size],
      color: marker.color,
      texture: MARKER_ATLAS,
      cell,
      alphaCutoff: 0.5,
      layer: layer + 2,
      generations: [generation],
    });
  }

  return { sprites, meshes: [], materials: [] };
}

function billboardCommands(
  options: MinimapOptions,
  profile: HardwareGenerationProfile,
  style: MarkerStyle,
  texture: string,
  markers: readonly MinimapMarker[],
  layer: number,
): Pick<MinimapView, 'sprites' | 'meshes' | 'materials'> {
  const { generation, rect, camera } = options;
  if (!camera) return { sprites: [], meshes: [], materials: [] };

  const view: BillboardCamera = {
    camera,
    screenWidth: profile.video.internalWidth,
    screenHeight: profile.video.internalHeight,
  };
  // 手前に出したい要素ほど小さい距離の殻に置く（`billboard.ts` の注記）
  const markerFrame = billboardFrame(view, BILLBOARD_DISTANCE);
  const shadowFrame = billboardFrame(view, BILLBOARD_DISTANCE * 1.04);
  const ringFrame = billboardFrame(view, BILLBOARD_DISTANCE * 1.08);
  const panelFrame = billboardFrame(view, enclosingDistance(view, BILLBOARD_DISTANCE * 1.08));

  // 板は光源に左右されない見え方にする（HUD なので陰影を付けない）
  const unlit = { ambient: 2.2, diffuse: 0, alphaCutoff: 0.35, filter: profile.video.textureFilter };
  const materials: MaterialCommand[] = [
    { id: `minimap-panel-${generation}`, baseColorTexture: texture, ...unlit, generations: [generation] },
    {
      id: `minimap-round-${generation}`,
      baseColorTexture: MARKER_TEXTURES.rival,
      ...unlit,
      generations: [generation],
    },
    {
      id: `minimap-square-${generation}`,
      baseColorTexture: MARKER_TEXTURES.player,
      ...unlit,
      generations: [generation],
    },
  ];

  const meshes: MeshCommand[] = [
    {
      id: `minimap-panel-${generation}`,
      geometry: BILLBOARD_GEOMETRY,
      transform: billboardBox(
        panelFrame,
        view,
        rect.left + rect.width / 2,
        rect.top + rect.height / 2,
        rect.width,
        rect.height,
      ),
      color: '#ffffff',
      material: `minimap-panel-${generation}`,
      layer,
      generations: [generation],
    },
  ];

  for (const marker of markers) {
    const [x, y] = marker.position;
    const material = marker.isPlayer
      ? `minimap-square-${generation}`
      : `minimap-round-${generation}`;
    if (style.playerRing && marker.isPlayer) {
      meshes.push({
        id: `minimap-ring-${generation}`,
        geometry: BILLBOARD_GEOMETRY,
        transform: billboardBox(ringFrame, view, x, y, marker.size * 1.9, marker.size * 1.9),
        color: '#ffffff',
        material: `minimap-round-${generation}`,
        layer: layer + 1,
        generations: [generation],
      });
    }
    if (style.shadow) {
      meshes.push({
        id: `minimap-shadow-${generation}-${marker.entrant}`,
        geometry: BILLBOARD_GEOMETRY,
        transform: billboardBox(shadowFrame, view, x + 1, y + 1, marker.size, marker.size),
        color: '#101018',
        material,
        layer: layer + 1,
        generations: [generation],
      });
    }
    meshes.push({
      id: `minimap-marker-${generation}-${marker.entrant}`,
      geometry: BILLBOARD_GEOMETRY,
      transform: billboardBox(markerFrame, view, x, y, marker.size, marker.size),
      color: marker.color,
      material,
      layer: layer + 2,
      generations: [generation],
    });
  }

  return { sprites: [], meshes, materials };
}

/** 組み立てた結果をフレームへ積む */
export function pushMinimap(frame: RenderFrame, options: MinimapOptions): MinimapView {
  const view = buildMinimap(options);
  for (const sprite of view.sprites) frame.sprites.push(sprite);
  for (const material of view.materials) frame.materials.push(material);
  for (const mesh of view.meshes) frame.meshes.push(mesh);
  return view;
}

/**
 * 世代ごとの既定の配置 — 安全領域の右下。
 *
 * FC だけは 8px グリッドに載せる（能力契約 `tileSnap`）。丸めるのは**枠の位置**であって
 * マーカーの座標ではない。実機でもマーカーはスプライト（OAM）で 1 画素単位に置けたが、
 * 枠は BG タイル面に描かれていたためタイル境界へ載った。
 */
export function defaultMinimapRect(
  generation: GenerationId,
  profile: HardwareGenerationProfile,
): MinimapRect {
  const layout = generationValue(MINIMAP_LAYOUTS, generation);
  const inset = Math.round(profile.video.internalWidth * 0.04);
  const snap = Math.max(1, profile.video.tileSnap);
  const left = Math.floor((profile.video.internalWidth - inset - layout.size) / snap) * snap;
  const top = Math.floor((profile.video.internalHeight - inset - layout.size) / snap) * snap;
  return { left, top, width: layout.size, height: layout.size };
}

/**
 * フェーズ 1 の可視化 — 画面いっぱいのミニマップ。
 *
 * 専用のデバッグ描画は作らない。本番と同じ `buildMinimap()` を大きな矩形で呼ぶだけで、
 * 8 台の走りとコース形状をそのまま確認できる。以降のフェーズでは
 * `defaultMinimapRect()` へ差し替えて右下に縮小配置する。
 */
export function fullScreenMinimapRect(profile: HardwareGenerationProfile): MinimapRect {
  const size = Math.round(
    Math.min(profile.video.internalWidth, profile.video.internalHeight) * 0.96,
  );
  return {
    left: Math.round((profile.video.internalWidth - size) / 2),
    top: Math.round((profile.video.internalHeight - size) / 2),
    width: size,
    height: size,
  };
}
