import {
  HARDWARE_GENERATION_PROFILES,
  affineUvAt,
  validateAffineSurface,
  type AffineSurfaceCommand,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import {
  AFFINE_BAND_ROWS,
  affineBandRows,
  affineRoadBands,
} from '../src/game/view/shared/affine-surface.js';
import {
  FC_CAMERA,
  SFC_CAMERA,
  SFC_DRAW_DISTANCE,
  createRoadView,
  roadTopRowForDistance,
} from '../src/game/view/shared/projection.js';
import { roadSurfaceFor, type RoadSurfaceLayout } from '../src/game/view/shared/road-surface.js';
import { TRACK } from '../src/game/sim/track.js';
import { SFC_ROAD_MAP, roadMapProjection } from '../src/game/view/shared/road-map.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 第2世代のアフィンサーフェス（実装計画 §6.2 `affine-surface.spec.ts`）。
 *
 * `validateAffineSurface` はレンダラーが実際に呼ぶ検証で、外れると**実行時に throw** する。
 * `affineUvAt` は同じシェーダの CPU 参照なので、
 * 「画面のこの画素はテクスチャのどこを引くか」をレンダラーと同じ式で確かめられる。
 * **投影（`RoadView`）が正しく UV へ落ちているか**をここで固定する。
 */

const PROFILE = HARDWARE_GENERATION_PROFILES.SFC;
const LAYOUT = roadSurfaceFor('SFC')!;
const RESOLUTION: readonly [number, number] = [
  PROFILE.video.internalWidth,
  PROFILE.video.internalHeight,
];

/** コース 1 周をまんべんなく見るための地点。カーブ・勾配・ヘアピンを跨ぐ */
const MOMENTS = [60, 400, 900, 1500, 2400, 3600, 5200, 7000];

const PROJECTION = roadMapProjection(TRACK.bounds, SFC_ROAD_MAP);

function viewAt(ticks: number, s?: number) {
  const state = raceAfter(ticks);
  const car = state.cars[0]!;
  return createRoadView({
    profile: PROFILE,
    camera: SFC_CAMERA,
    track: state.track,
    car: s === undefined ? car : { ...car, s, lateral: 0 },
    layout: LAYOUT,
    maxDistance: SFC_DRAW_DISTANCE,
  });
}

/** 帯が画面 x 列で引いているワールド XZ。UV を世界へ戻す */
function worldAt(band: AffineSurfaceCommand, x: number): [number, number] {
  const [u, v] = rawUv(band, x);
  return [
    PROJECTION.originX + (u * PROJECTION.width) / SFC_ROAD_MAP.texelsPerMeter,
    PROJECTION.originZ + (v * PROJECTION.height) / SFC_ROAD_MAP.texelsPerMeter,
  ];
}

/** clamp を掛ける前の生の UV。範囲外へ出たかどうかを見たいのでこちらを使う */
function rawUv(band: AffineSurfaceCommand, x: number): [number, number] {
  return [
    band.uvOrigin[0] + band.uvStepX[0] * x,
    band.uvOrigin[1] + band.uvStepX[1] * x,
  ];
}

describe('第2世代のアフィンサーフェス', () => {
  for (const ticks of MOMENTS) {
    it(`tick ${ticks}: 全行で validateAffineSurface が通る`, () => {
      const bands = buildFrame('SFC', raceAfter(ticks)).affineSurfaces;
      expect(bands.length).toBeGreaterThan(0);
      for (const band of bands) validateAffineSurface(band, RESOLUTION);
    });
  }

  it('路面帯が上端から画面下端まで隙間なく並ぶ', () => {
    const bands = buildFrame('SFC', raceAfter(1500)).affineSurfaces;
    expect(bands[0]!.screenRect[1]).toBe(SFC_CAMERA.roadTopRow);
    for (let index = 1; index < bands.length; index++) {
      const previous = bands[index - 1]!.screenRect;
      expect(bands[index]!.screenRect[1]).toBe(previous[1] + previous[3]);
      expect(bands[index]!.screenRect[0]).toBe(0);
      expect(bands[index]!.screenRect[2]).toBe(PROFILE.video.internalWidth);
    }
    const last = bands[bands.length - 1]!.screenRect;
    expect(last[1] + last[3]).toBe(PROFILE.video.internalHeight);
  });

  it('上端行が設計した描画距離（220 m）と一致する', () => {
    expect(SFC_CAMERA.roadTopRow).toBe(roadTopRowForDistance(SFC_CAMERA, SFC_DRAW_DISTANCE));
    // 第1世代は走査線 width ≤ 1 に縛られて 98 m で頭打ちになる。ここが世代差の実体
    const fcMaxDistance =
      (roadSurfaceFor('FC')!.spanMeters * FC_CAMERA.focal) / PROFILE.video.internalWidth;
    expect(SFC_DRAW_DISTANCE).toBeGreaterThan(fcMaxDistance * 2);
  });

  describe('投影と UV の一致（マップの上で確かめる）', () => {
    it('画面の各点が、その点が見ているワールド上の地面を引く', () => {
      // マップの UV はワールド XZ の写像なので、**引いた UV を世界へ戻して
      // コース座標に直せる**。投影（RoadView）と UV が同じ地面を指しているかを、
      // テクスチャの割合ではなく実寸で確かめられる
      const view = viewAt(900);
      const bands = affineRoadBands({ generation: 'SFC', view, track: TRACK });
      let near = 0;
      let far = 0;

      for (const band of bands) {
        const distance = Math.min(
          SFC_ROAD_MAP.farClip,
          view.distanceAtRow(band.screenRect[1] + band.screenRect[3] / 2),
        );
        const scale = view.scaleAt(distance);
        for (const lateral of [-LAYOUT.roadHalfWidth, 0, LAYOUT.roadHalfWidth]) {
          const x = view.centerXAt(distance) + lateral * scale;
          const [worldX, worldZ] = worldAt(band, x);
          const location = TRACK.toTrack(worldX, worldZ, view.originS + distance);
          const error = Math.abs(location.lateral - lateral);
          near = Math.max(near, error / (distance * distance));
          far = Math.max(far, error);
        }
      }

      // ずれは距離の 2 乗に比例する。`centerXAt` が「弧長 z 先の中心線」を置くのに対し
      // マップは「カメラから直線距離 z の点」を引くためで、係数はコースの曲率そのもの。
      // **投影の側の近似であって UV の導出の誤差ではない** — 定数項が乗っていたら導出が疑わしい
      expect(near).toBeLessThan(3e-5);
      // 実寸では最遠でも 1 m 未満（画面では 1.4 px）
      expect(far).toBeLessThan(1);
    });

    it('affineUvAt（レンダラーの CPU 参照）が同じ値を返す', () => {
      const view = viewAt(1500);
      const bands = affineRoadBands({ generation: 'SFC', view, track: TRACK });

      for (const band of bands) {
        for (const x of [0.5, 64.5, 128.5, 255.5]) {
          const [rawU, rawV] = rawUv(band, x);
          const [u, v] = affineUvAt(band, [x, 0.5], 'clamp');
          expect(u).toBeCloseTo(Math.min(1, Math.max(0, rawU)), 6);
          expect(v).toBeCloseTo(Math.min(1, Math.max(0, rawV)), 6);
        }
      }
    });

    it('行が見る距離が遠クリップで止まる（窓に収める条件）', () => {
      // 下り坂では最上行が 358 m 先まで見る。マップを引く距離だけ止めないと、
      // 1 フレームで引く地面が実機の Mode 7 面（1024²）に収まらない
      for (const ticks of MOMENTS) {
        const state = raceAfter(ticks);
        const view = createRoadView({
          profile: PROFILE,
          camera: SFC_CAMERA,
          track: state.track,
          car: state.cars[0]!,
          layout: LAYOUT,
          maxDistance: SFC_DRAW_DISTANCE,
        });
        const bands = affineRoadBands({ generation: 'SFC', view, track: state.track });
        const eye = state.track.toWorld(view.originS, view.originLateral);
        for (const band of bands) {
          const [worldX, worldZ] = worldAt(band, PROFILE.video.internalWidth / 2);
          const distance = Math.hypot(worldX - eye[0], worldZ - eye[2]);
          expect(distance, `tick ${ticks} 行 ${band.screenRect[1]}`).toBeLessThanOrEqual(
            SFC_ROAD_MAP.farClip + 1e-6,
          );
        }
      }
    });
  });

  describe('コーナーで視界が回る（マップ参照の本題）', () => {
    it('画面の横方向がワールドの右方向と一致する', () => {
      // 帯テクスチャでは「傾き」は上限を掛けた演出だった。マップでは
      // uvStepX がそのまま視点の right ベクトルなので、演出の余地が無い
      const view = viewAt(1500);
      const bands = affineRoadBands({ generation: 'SFC', view, track: TRACK });
      const [rightX, rightZ] = TRACK.sampleAt(view.originS).right;

      for (const band of bands) {
        const [stepX, stepZ] = [
          (band.uvStepX[0] * PROJECTION.width) / SFC_ROAD_MAP.texelsPerMeter,
          (band.uvStepX[1] * PROJECTION.height) / SFC_ROAD_MAP.texelsPerMeter,
        ];
        const length = Math.hypot(stepX, stepZ);
        expect(stepX / length).toBeCloseTo(rightX, 6);
        expect(stepZ / length).toBeCloseTo(rightZ, 6);
      }
    });

    it('ヘアピンでは奥の行ほど路面が画面の横へ流れる', () => {
      // コースの形をそのまま引くので、コーナーの先の路面が画面に出る。
      // 直線ではどの行も路面中心が画面中央付近に残る
      const offsetAt = (s: number) => {
        const view = viewAt(0, s);
        const bands = affineRoadBands({ generation: 'SFC', view, track: TRACK });
        const top = bands[0]!;
        const [worldX, worldZ] = worldAt(top, PROFILE.video.internalWidth / 2);
        return Math.abs(TRACK.toTrack(worldX, worldZ).lateral);
      };
      // s = 1600 はヘアピン進入、s = 200 はホームストレート
      expect(offsetAt(1600)).toBeGreaterThan(40);
      expect(offsetAt(200)).toBeLessThan(15);
    });
  });

  describe('clamp の扱い', () => {
    it('マップの外は単色で埋まる（repeat なら二本目の道路になる）', () => {
      const bands = buildFrame('SFC', raceAfter(900)).affineSurfaces;
      expect(bands.every((band) => band.wrap === 'clamp')).toBe(true);
    });

    it('コース上にいるかぎり、引く UV はマップの内側に収まる', () => {
      for (const ticks of MOMENTS) {
        const bands = buildFrame('SFC', raceAfter(ticks)).affineSurfaces;
        for (const band of bands) {
          for (const x of [0, PROFILE.video.internalWidth]) {
            const [u, v] = rawUv(band, x);
            expect(u, `tick ${ticks} 行 ${band.screenRect[1]} の U`).toBeGreaterThan(-0.2);
            expect(u).toBeLessThan(1.2);
            expect(v, `tick ${ticks} 行 ${band.screenRect[1]} の V`).toBeGreaterThan(-0.2);
            expect(v).toBeLessThan(1.2);
          }
        }
      }
    });
  });

  describe('帯の粒度', () => {
    it('既定は 1 行ごと。切替演出中は 2 行へ落として本数を半分にする', () => {
      expect(affineBandRows(1)).toBe(AFFINE_BAND_ROWS.detailed);
      expect(affineBandRows(2)).toBe(AFFINE_BAND_ROWS.coarse);

      const state = raceAfter(1500);
      const single = buildFrame('SFC', state).affineSurfaces;
      const during = buildFrame('SFC', state, 10, 2).affineSurfaces;
      expect(single).toHaveLength(PROFILE.video.internalHeight - SFC_CAMERA.roadTopRow);
      expect(during.length).toBe(Math.ceil(single.length / 2));
      // ドローコール予算（§6.3）は 240。切替中は 2 世代ぶん積まれる
      expect(single.length).toBeLessThanOrEqual(240);
      expect(during.length * 2).toBeLessThanOrEqual(240);
    });

    it('粗い帯でも検証を通り、隙間なく並ぶ', () => {
      const bands = buildFrame('SFC', raceAfter(1500), 10, 2).affineSurfaces;
      let row = SFC_CAMERA.roadTopRow;
      for (const band of bands) {
        validateAffineSurface(band, RESOLUTION);
        expect(band.screenRect[1]).toBe(row);
        row += band.screenRect[3];
      }
      expect(row).toBe(PROFILE.video.internalHeight);
    });
  });

  describe('マップの前提', () => {
    it('引くのはコースマップで、帯テクスチャではない', () => {
      const bands = buildFrame('SFC', raceAfter(900)).affineSurfaces;
      expect(bands.every((band) => band.texture === SFC_ROAD_MAP.texture)).toBe(true);
      expect(SFC_ROAD_MAP.texture).not.toBe(LAYOUT.texture);
    });

    it('路面の実寸がコース定義（半幅 6 m）と一致している', () => {
      const layout: RoadSurfaceLayout = LAYOUT;
      expect(layout.roadHalfWidth).toBe(6);
    });
  });
});

describe('第2世代のビュー', () => {
  it('遠方ほど厚いフォグの帯が重なる', () => {
    const frame = buildFrame('SFC', raceAfter(1500));
    const fog = frame.sprites.filter((sprite) => sprite.id.startsWith('road-fog-'));
    expect(fog.length).toBeGreaterThanOrEqual(2);

    for (const band of fog) {
      // すべて路面帯の上端から始まる（重なるほど霞が濃くなる）
      expect(band.position[1] - band.size[1] / 2).toBeCloseTo(SFC_CAMERA.roadTopRow, 6);
      expect(band.size[0]).toBe(PROFILE.video.internalWidth);
      expect(band.hardwareBlend).toMatchObject({
        family: 'gen2-color-math',
        operation: 'add',
        half: true,
        operand: 'fixed',
      });
    }
  });

  it('車には color math の落ち影が付く', () => {
    const frame = buildFrame('SFC', raceAfter(1500));
    const cars = frame.sprites.filter((sprite) => sprite.id.startsWith('car-sprite-'));
    const shadows = frame.sprites.filter((sprite) => sprite.id.startsWith('car-shadow-'));
    expect(cars.length).toBeGreaterThan(0);
    expect(shadows).toHaveLength(cars.length);

    for (const shadow of shadows) {
      expect(shadow.hardwareBlend).toMatchObject({
        family: 'gen2-color-math',
        operation: 'subtract',
        half: true,
      });
      // 影は車より手前に積まない（半透明スプライトはシーンへ合成されるので必ず奥になる）
      expect(shadow.size[1]).toBeLessThan(shadow.size[0]);
    }
  });

  it('スプライトが 8 px グリッドに縛られない（第1世代との差がそのまま滑らかさの差）', () => {
    // `tileSnap: 1` は「丸めない」ではなく「1 px 単位」。実機の OAM も整数画素だった。
    // 第1世代との差は**8 px のタイル境界から自由になること**にある
    expect(PROFILE.video.tileSnap).toBe(1);
    const positions: number[] = [];
    for (const ticks of MOMENTS) {
      for (const sprite of buildFrame('SFC', raceAfter(ticks)).sprites) {
        if (!sprite.id.startsWith('car-sprite-')) continue;
        positions.push(sprite.position[0]);
      }
    }
    expect(positions.length).toBeGreaterThan(0);
    expect(positions.every((value) => Number.isInteger(value))).toBe(true);
    expect(positions.some((value) => value % 8 !== 0)).toBe(true);
  });
});
