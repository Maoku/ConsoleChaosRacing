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
import {
  patternPeriodMeters,
  roadSurfaceFor,
  type RoadSurfaceLayout,
} from '../src/game/view/shared/road-surface.js';
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

function viewAt(ticks: number) {
  const state = raceAfter(ticks);
  return createRoadView({
    profile: PROFILE,
    camera: SFC_CAMERA,
    track: state.track,
    car: state.cars[0]!,
    layout: LAYOUT,
    maxDistance: SFC_DRAW_DISTANCE,
  });
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

  describe('投影と UV の一致（affineUvAt との突き合わせ）', () => {
    it('路面の中心と両端が、テクスチャの路面の中心と両端を引く', () => {
      const view = viewAt(900);
      const bands = affineRoadBands({ generation: 'SFC', view });
      const halfRoad = LAYOUT.roadHalfWidth / LAYOUT.spanMeters;

      for (const band of bands) {
        const distance = view.distanceAtRow(band.screenRect[1] + band.screenRect[3] / 2);
        // 傾いた行は路面の横方向が画面の横方向と一致しないので、直線に近い行だけを見る
        if (Math.abs(view.headingDeltaAt(distance)) > 0.02) continue;
        const scale = view.scaleAt(distance);

        for (const [lateral, expectedU] of [
          [0, 0.5],
          [-LAYOUT.roadHalfWidth, 0.5 - halfRoad],
          [LAYOUT.roadHalfWidth, 0.5 + halfRoad],
        ] as const) {
          const x = view.centerXAt(distance) + lateral * scale;
          const [u] = rawUv(band, x);
          // 許容は U の 1e-4（＝路面の実寸で 1 cm）。傾きが厳密に 0 でない行では
          // cos φ ぶんのわずかな差が残る
          expect(u, `距離 ${distance.toFixed(1)} m・横 ${lateral} m`).toBeCloseTo(expectedU, 4);
        }
      }
    });

    it('affineUvAt（レンダラーの CPU 参照）が同じ値を返す', () => {
      const view = viewAt(1500);
      const bands = affineRoadBands({ generation: 'SFC', view });

      for (const band of bands) {
        for (const x of [0.5, 64.5, 128.5, 255.5]) {
          const [rawU, rawV] = rawUv(band, x);
          const [u, v] = affineUvAt(band, [x, 0.5], 'clamp');
          expect(u).toBeCloseTo(Math.min(1, Math.max(0, rawU)), 6);
          expect(v).toBeCloseTo(Math.min(1, Math.max(0, rawV)), 6);
        }
      }
    });

    it('V の位相が進行距離に対応する（模様の 1 周期の剰余で一致）', () => {
      const view = viewAt(400);
      const bands = affineRoadBands({ generation: 'SFC', view });
      const pattern = patternPeriodMeters(LAYOUT);
      const patternV = pattern / LAYOUT.periodMeters;

      for (const band of bands) {
        const distance = view.distanceAtRow(band.screenRect[1] + band.screenRect[3] / 2);
        const [, v] = rawUv(band, PROFILE.video.internalWidth / 2);
        const along = (view.originS + distance) / pattern;
        const expected = (along - Math.floor(along)) * patternV;
        // 1 周期ずらしても同じ絵になるので、剰余で比べる
        const difference = (((v - expected) / patternV) % 1 + 1) % 1;
        expect(Math.min(difference, 1 - difference)).toBeLessThan(1e-6);
      }
    });
  });

  describe('clamp の扱い', () => {
    it('V はどの行でもテクスチャの内側に収まる（模様が端で潰れない）', () => {
      for (const ticks of MOMENTS) {
        const bands = buildFrame('SFC', raceAfter(ticks)).affineSurfaces;
        for (const band of bands) {
          for (const x of [0, PROFILE.video.internalWidth]) {
            const [, v] = rawUv(band, x);
            expect(v, `tick ${ticks} 行 ${band.screenRect[1]} の V`).toBeGreaterThan(0);
            expect(v).toBeLessThan(1);
          }
        }
      }
    });

    it('U は範囲外へ出てよい（草地が伸びる。repeat なら二本目の道路になる）', () => {
      const bands = buildFrame('SFC', raceAfter(900)).affineSurfaces;
      expect(bands.every((band) => band.wrap === 'clamp')).toBe(true);
      const outside = bands.some((band) => {
        const [left] = rawUv(band, 0);
        const [right] = rawUv(band, PROFILE.video.internalWidth);
        return left < 0 || right > 1;
      });
      expect(outside).toBe(true);
    });
  });

  describe('コーナーでの視界の傾き', () => {
    it('直線では傾かず、コーナーでは V 成分が立つ', () => {
      const tilts = MOMENTS.map((ticks) => {
        const bands = buildFrame('SFC', raceAfter(ticks)).affineSurfaces;
        return Math.max(...bands.map((band) => Math.abs(band.uvStepX[1])));
      });
      // どこかのコーナーでは明確に傾き、どの地点でも上限を超えない
      expect(Math.max(...tilts)).toBeGreaterThan(1e-4);
      const span = PROFILE.video.internalWidth;
      expect(Math.max(...tilts) * span).toBeLessThanOrEqual(0.5 + 1e-9);
    });

    it('傾きの符号が前方の路面の向きと一致する', () => {
      const view = viewAt(1500);
      const bands = affineRoadBands({ generation: 'SFC', view });
      for (const band of bands) {
        const distance = view.distanceAtRow(band.screenRect[1] + band.screenRect[3] / 2);
        const delta = view.headingDeltaAt(distance);
        if (Math.abs(delta) < 0.05) continue;
        // 右へ曲がる先では、画面を右へ進むほど「進行方向の先」を引く
        expect(Math.sign(band.uvStepX[1])).toBe(Math.sign(delta));
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

  describe('路面テクスチャの前提', () => {
    it('模様の周期がテクスチャ 1 枚に整数回入る（V をずらせる根拠）', () => {
      const pattern = patternPeriodMeters(LAYOUT);
      expect(pattern).toBe(LAYOUT.dashMeters + LAYOUT.dashGapMeters);
      expect(pattern).toBe(LAYOUT.kerbStripeMeters * 2);
      const repeats = LAYOUT.periodMeters / pattern;
      expect(repeats).toBe(Math.round(repeats));
      // 4 周期ぶんの余白が、傾けた行の V の遊びになる
      expect(repeats).toBeGreaterThanOrEqual(4);
    });

    it('テクスチャ 1 枚が最遠の行の画面幅より広い（二本目の道路が出ない条件）', () => {
      const widest = (SFC_DRAW_DISTANCE * PROFILE.video.internalWidth) / SFC_CAMERA.focal;
      expect(LAYOUT.spanMeters).toBeGreaterThanOrEqual(widest / 2);
      // 路面の実寸がコース定義（半幅 6 m）と一致していること
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
