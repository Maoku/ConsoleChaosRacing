import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type RenderFrame,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import type { DisplayCar } from './display-state.js';
import {
  MARKER_ATLAS,
  MINIMAP_LAYOUTS,
  minimapNormalized,
  minimapPoint,
  minimapProjection,
  type MinimapLayout,
  type MinimapProjection,
  type MinimapRect,
} from './minimap-layout.js';
import { ENTRANT_COLORS, PLAYER_ENTRANT } from './variants.js';

/**
 * ミニマップ — 4 世代の下に共通して敷かれる 5 番目のビュー（実装計画 §3.6）。
 *
 * プレイヤーへの情報提供に加えて、**4 世代が 1 つのシミュレーションで動いていることを
 * 画面上で証明する**装置として扱う。マーカーの位置は 4 世代とも
 * `track.toWorld()` → `minimapPoint()` というまったく同じ 1 本の計算で決まり、
 * 世代差は矩形・寸法・色・半透明の作法だけである。
 *
 * エンジン 0.2.0 で PS1 / PS2 のスプライトが ordering table 経由でシーンへ統合され、
 * **4 世代すべてが同じ `SpriteCommand` の経路に乗る**ようになった。
 * 積む順序がそのまま重ね順になる（スクリーン空間スプライトは PS1 では固定 slot 10、
 * PS2 ではシーン末尾。どちらも同じ slot 内では登録順が安定して保たれる）。
 */

const MINIMAP_TEXTURES: GenerationVariant<string> = defineGenerationVariant({
  FC: 'assets/gen1/hud/minimap.png',
  SFC: 'assets/gen2/hud/minimap.png',
  PS1: 'assets/gen3/hud/minimap.png',
  PS2: 'assets/gen4/hud/minimap.png',
});

const MARKER_CELL = MARKER_ATLAS.cells;

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
  /** 枠のスプライト。パネルを持つ世代では半透明合成が指定されている */
  readonly panelSprite: SpriteCommand;
  /** 登録順のマーカースプライト（影・強調縁を含む） */
  readonly markerSprites: readonly SpriteCommand[];
  /**
   * `markers` と 1:1 で並ぶ、そのマーカーを構成するスプライト（影・縁を含む）。
   * 第1世代は走査線制限でマーカーを 1 つずつ落とす必要があるため、
   * 「どのスプライトがどの車のものか」を平坦な配列とは別に保つ。
   */
  readonly markerSpriteGroups: readonly (readonly SpriteCommand[])[];
}

export interface MinimapOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly track: Track;
  /**
   * 世代の更新レートへ量子化済みの車。`RaceState.cars` をそのまま渡すと
   * マーカーが 60Hz で動いてしまい、第1世代の 6Hz が出ない（`DisplayLatch` を通す）
   */
  readonly cars: readonly DisplayCar[];
  readonly rect: MinimapRect;
  /**
   * 量子化済みのフレーム番号。マーカーの登録順を毎フレーム巡回させるのに使う
   * （実機の OAM ローテーションと同じ手法。密集しても消えっぱなしにならない）
   */
  readonly frameIndex?: number;
  readonly layer?: number;
}

function markerColor(car: DisplayCar, style: MarkerStyle): string {
  if (car.entrant === PLAYER_ENTRANT) return style.playerColor;
  if (!style.useStandingColors) return style.rivalColor;
  const podium = STANDING_COLORS[car.standing - 1];
  return podium ?? ENTRANT_COLORS[car.entrant % ENTRANT_COLORS.length] ?? style.rivalColor;
}

/**
 * 登録順を決める。自機を必ず先頭に置いて消えないようにし、
 * ライバルのマーカーはフレームごとに順序を巡回させる（実装計画 §3.6）。
 */
function registrationOrder(
  cars: readonly DisplayCar[],
  frameIndex: number,
): DisplayCar[] {
  const player = cars.find((car) => car.entrant === PLAYER_ENTRANT);
  const rivals = cars.filter((car) => car.entrant !== PLAYER_ENTRANT);
  const rotation = rivals.length > 0 ? frameIndex % rivals.length : 0;
  const ordered: DisplayCar[] = [];
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
  const { generation, track, cars, rect } = options;
  const layout = generationValue(MINIMAP_LAYOUTS, generation);
  const style = generationValue(MARKER_STYLES, generation);
  const texture = generationValue(MINIMAP_TEXTURES, generation);
  const projection = minimapProjection(track.bounds, rect, layout.margin);
  const layer = options.layer ?? 40;
  const markerScale = Math.max(1, layout.markerSize * (rect.width / layout.size));

  const markers: MinimapMarker[] = [];
  for (const car of registrationOrder(cars, options.frameIndex ?? 0)) {
    // ── 4 世代とも、ここが同じ 1 本の計算になっている
    const world = track.toWorld(car.s, car.lateral);
    const normalized = minimapNormalized(track.bounds, world[0], world[2]);
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

  const panelSprite: SpriteCommand = {
    id: `minimap-panel-${generation}`,
    screenSpace: true,
    position: [rect.left + rect.width / 2, rect.top + rect.height / 2, 0],
    size: [rect.width, rect.height],
    color: '#ffffff',
    texture,
    cell: 0,
    alphaCutoff: 0.02,
    layer,
    // 半透明の作法は世代ごとに違う。FC は panelBlend が null なので何も付かない
    ...(layout.panelBlend ? { hardwareBlend: layout.panelBlend } : {}),
    generations: [generation],
  };

  const markerSpriteGroups: SpriteCommand[][] = [];
  for (const marker of markers) {
    const [x, y] = marker.position;
    const cell = marker.isPlayer ? MARKER_CELL.player : MARKER_CELL.rival;
    const markerSprites: SpriteCommand[] = [];
    markerSpriteGroups.push(markerSprites);
    if (style.playerRing && marker.isPlayer) {
      markerSprites.push({
        id: `minimap-ring-${generation}`,
        screenSpace: true,
        position: [x, y, 0],
        size: [marker.size * 1.9, marker.size * 1.9],
        color: '#ffffff',
        texture: MARKER_ATLAS.url,
        cell: MARKER_CELL.rival,
        alphaCutoff: 0.5,
        layer: layer + 1,
        generations: [generation],
      });
    }
    if (style.shadow) {
      markerSprites.push({
        id: `minimap-shadow-${generation}-${marker.entrant}`,
        screenSpace: true,
        position: [x + 1, y + 1, 0],
        size: [marker.size, marker.size],
        color: '#101018',
        texture: MARKER_ATLAS.url,
        cell,
        alphaCutoff: 0.5,
        layer: layer + 1,
        generations: [generation],
      });
    }
    // マーカー自体は不透明。順位と自機がひと目で分かることを半透明より優先する
    markerSprites.push({
      id: `minimap-marker-${generation}-${marker.entrant}`,
      screenSpace: true,
      position: [x, y, 0],
      size: [marker.size, marker.size],
      color: marker.color,
      texture: MARKER_ATLAS.url,
      cell,
      alphaCutoff: 0.5,
      layer: layer + 2,
      generations: [generation],
    });
  }

  return {
    layout,
    projection,
    rect,
    markers,
    panelSprite,
    markerSprites: markerSpriteGroups.flat(),
    markerSpriteGroups,
  };
}

/** 組み立てた結果をフレームへ積む。積んだ順がそのまま重ね順になる */
export function pushMinimap(frame: RenderFrame, options: MinimapOptions): MinimapView {
  const view = buildMinimap(options);
  frame.sprites.push(view.panelSprite);
  for (const sprite of view.markerSprites) frame.sprites.push(sprite);
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
