import type {
  MaterialCommand,
  MeshCommand,
  OrderingTableIndex,
  RenderFrame,
} from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import { carModelFor, carTextureFor, carTransform } from './shared/car-model.js';
import { hidesPlayerCar, resolveCameraView, viewCamera } from './shared/camera.js';
import { pushHud } from './shared/hud.js';
import { defaultMinimapRect, pushMinimap } from './shared/minimap.js';
import {
  trackMeshLodFor,
  trackSectorAsset,
  trackSurfaceTexture,
  visibleSectors,
} from './shared/track-mesh.js';
import { ENTRANT_COLORS, PLAYER_ENTRANT } from './shared/variants.js';

/**
 * 第3世代（PS1）— 深度バッファの無い 3D（実装計画 §3.4）。
 *
 * レンダラーが自動でやること: 320×240 / 頂点量子化 2 / アフィンテクスチャ /
 * nearest フィルタ / S-Video の CRT。**これらを打ち消そうとしない**のがこの世代の設計。
 *
 * ゲーム側が受け持つのは次の 3 つ。
 *
 * 1. 前後関係 — 深度バッファが無いので 12 スロットの ordering table で決める。
 *    路面は `polygonSortRange: [1, 8]` で三角形単位に分配し、車は固定スロット 9 へ置く。
 *    こうすると車が路面へ埋まらない（0.2.0 のリリースノートが挙げた対処そのもの）。
 * 2. 描画距離 — フォグで切る。当時の短い描画距離はここで出る。
 * 3. 見た目の更新レート — `DisplayLatch` が 30Hz に丸めた値だけを読む。
 */

/** 空と地平（＝フォグ）の色。海辺のサーキットの霞んだ空気 */
const SKY_TOP = '#20406c';
const HORIZON = '#8fb0c4';
/** フォグ密度 [1/m]。exp(-d·density) なので 100 m で約 75% 霞む */
const FOG_DENSITY = 0.014;

/** 路面のスロット範囲。三角形単位に view-space depth で分配される */
const TRACK_SORT_RANGE: readonly [OrderingTableIndex, OrderingTableIndex] = [1, 8];
/** 車の固定スロット。路面の範囲より必ず後に描かれる */
const CAR_SLOT: OrderingTableIndex = 9;

/**
 * `asset` 付きメッシュの `geometry` は参照されないが、`quad` の `halfSize` だけは
 * モデル行列へ掛かる。単位のまま置く。
 */
const TRACK_GEOMETRY = { kind: 'quad', halfSize: [1, 1] } as const;

/** 動的ライトが無いぶん、焼き込み風に明るめのマテリアルにする */
const UNLIT = { ambient: 0.92, diffuse: 0.28 } as const;

export function buildGen3View(frame: RenderFrame, context: ViewContext): void {
  const { generation, profile, state, display } = context;
  const track = state.track;
  const lod = trackMeshLodFor(generation);
  const carModel = carModelFor(generation);
  const player = display.cars[PLAYER_ENTRANT];
  if (!lod || !carModel || !player) return;

  // 視点は自分の世代にあるものへ落とす（8-5）。第3世代は追走とフロントガラスの 2 つ
  const view = resolveCameraView(generation, context.cameraView ?? 'chase');
  frame.camera = viewCamera({ track, car: player, view });

  frame.backgrounds.push({
    color: HORIZON,
    secondaryColor: SKY_TOP,
    fogDensity: FOG_DENSITY,
    generations: [generation],
  });

  // ── 路面。1 枚のアトラスなのでマテリアルは 1 つで足りる
  const trackMaterial: MaterialCommand = {
    id: `track-${generation}`,
    baseColorTexture: trackSurfaceTexture(lod),
    uvMode: 'affine',
    polygonSort: true,
    ...UNLIT,
    generations: [generation],
  };
  frame.materials.push(trackMaterial);

  for (const sector of visibleSectors(lod, player.s, track.length)) {
    frame.meshes.push({
      id: `track-${generation}-${sector}`,
      // asset があればジオメトリは引かれないが、quad の halfSize だけは
      // モデル行列へ掛かってしまう。[1, 1] 以外を書くとメッシュが歪む
      geometry: TRACK_GEOMETRY,
      asset: trackSectorAsset(lod, sector),
      transform: { position: [0, 0, 0] },
      color: '#ffffff',
      material: trackMaterial.id,
      polygonSortRange: TRACK_SORT_RANGE,
      receiveShadow: true,
      generations: [generation],
    });
  }

  // ── 車。塗装テクスチャは無彩色なので 8 台で 1 枚を共有し、
  // 車体色は MeshCommand.color の乗算だけで決まる（`CAR_PAINT` の注記）
  const carMaterial: MaterialCommand = {
    id: `car-${generation}`,
    baseColorTexture: carTextureFor(generation),
    uvMode: 'affine',
    polygonSort: true,
    ...UNLIT,
    generations: [generation],
  };
  frame.materials.push(carMaterial);

  // 同じスロットの中では登録順が保たれる。遠い車から積んで、近い車を後に描く
  const hidePlayer = hidesPlayerCar(view);
  const camera = frame.camera.position;
  const ordered = [...display.cars].sort((left, right) => {
    return distanceTo(track, camera, right) - distanceTo(track, camera, left);
  });

  for (const car of ordered) {
    // 車内からの視点では自機を積まない。運転席から自分の車体は見えない
    if (hidePlayer && car.entrant === PLAYER_ENTRANT) continue;
    const groundY = track.toWorld(car.s, car.lateral)[1];
    frame.meshes.push({
      id: `car-${generation}-${car.entrant}`,
      geometry: TRACK_GEOMETRY,
      asset: carModel.asset,
      transform: carTransform(track, car),
      color: ENTRANT_COLORS[car.entrant % ENTRANT_COLORS.length] ?? '#ffffff',
      material: carMaterial.id,
      orderTableIndex: CAR_SLOT,
      castShadow: true,
      groundY,
      generations: [generation],
    } satisfies MeshCommand);
  }

  // ── ミニマップは右下へ縮小配置する（フェーズ 1 の全画面表示から差し替え）
  pushMinimap(frame, {
    generation,
    profile,
    track,
    cars: display.cars,
    rect: defaultMinimapRect(generation, profile),
    frameIndex: display.frameIndex,
  });

  // HUD は最後 ＝ 最前面。スクリーン空間スプライトは固定スロット 10 へ入り、
  // 同じスロットの中では積んだ順が保たれる
  pushHud(frame, { generation, profile, display, screen: context.screen });
}

function distanceTo(
  track: ViewContext['state']['track'],
  camera: readonly [number, number, number],
  car: { s: number; lateral: number },
): number {
  const world = track.toWorld(car.s, car.lateral);
  return (
    (world[0] - camera[0]) ** 2 + (world[1] - camera[1]) ** 2 + (world[2] - camera[2]) ** 2
  );
}
