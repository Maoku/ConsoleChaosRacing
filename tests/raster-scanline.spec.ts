import { HARDWARE_GENERATION_PROFILES, validateRasterSurface } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import {
  FC_CAMERA,
  createRoadView,
  farRoadWidthPx,
  roadTopRowFor,
} from '../src/game/view/shared/projection.js';
import { ROAD_SURFACE, roadFraction } from '../src/game/view/shared/road-surface.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * 第1世代のラスターサーフェス（実装計画 §6.2 `raster-scanline.spec.ts`）。
 *
 * `validateRasterSurface` はレンダラーが実際に呼ぶ検証で、外れると**実行時に throw** する。
 * ここで先に呼んでおけば、走行中のどの地点で条件を割るかを画面を見ずに捕まえられる。
 */

const PROFILE = HARDWARE_GENERATION_PROFILES.FC;
const RESOLUTION: readonly [number, number] = [
  PROFILE.video.internalWidth,
  PROFILE.video.internalHeight,
];

/** コース 1 周をまんべんなく見るための地点。カーブ・勾配・ヘアピンを跨ぐ */
const MOMENTS = [60, 400, 900, 1500, 2400, 3600, 5200, 7000];

describe('第1世代のラスターサーフェス', () => {
  for (const ticks of MOMENTS) {
    it(`tick ${ticks}: validateRasterSurface が通る`, () => {
      const frame = buildFrame('FC', raceAfter(ticks));
      expect(frame.rasterSurfaces).toHaveLength(1);
      const surface = frame.rasterSurfaces[0]!;
      const rows = validateRasterSurface(surface, RESOLUTION);
      expect(rows).toBe(surface.screenRect[3]);
      expect(surface.scanlines).toHaveLength(rows * 4);
    });
  }

  it('走査線の 4 値がすべて定義域に収まる', () => {
    for (const ticks of MOMENTS) {
      const surface = buildFrame('FC', raceAfter(ticks)).rasterSurfaces[0]!;
      const rows = surface.screenRect[3];
      for (let row = 0; row < rows; row++) {
        const [center, width, sourceV, brightness] = surface.scanlines.subarray(
          row * 4,
          row * 4 + 4,
        );
        // center と sourceV は 8bit へ書き出すとき fract される。[0, 1) を出ると
        // 路面が反対側から巻き戻って現れるので、CPU 側で収めておく
        expect(center, `tick ${ticks} 行 ${row} の center`).toBeGreaterThanOrEqual(0);
        expect(center).toBeLessThan(1);
        expect(sourceV).toBeGreaterThanOrEqual(0);
        expect(sourceV).toBeLessThan(1);
        expect(width, `tick ${ticks} 行 ${row} の width`).toBeGreaterThan(0);
        expect(width).toBeLessThanOrEqual(1);
        expect(brightness).toBeGreaterThanOrEqual(0);
        expect(brightness).toBeLessThanOrEqual(1);
      }
    }
  });

  it('路面帯が画面下端まで届き、地平線より下に収まっている', () => {
    const surface = buildFrame('FC', raceAfter(1500)).rasterSurfaces[0]!;
    const [left, top, width, height] = surface.screenRect;
    expect(left).toBe(0);
    expect(width).toBe(PROFILE.video.internalWidth);
    expect(top + height).toBe(PROFILE.video.internalHeight);
    expect(top).toBeGreaterThan(FC_CAMERA.horizonRow);
    // 上端行は「width が 1 を超えない最初の行」。設計値と実装値がずれていないこと
    expect(top).toBe(roadTopRowFor(PROFILE, FC_CAMERA));
    expect(FC_CAMERA.roadTopRow).toBe(top);
  });

  it('手前ほど路面が広く写る（＝奥へ収束している）', () => {
    const surface = buildFrame('FC', raceAfter(1500)).rasterSurfaces[0]!;
    const rows = surface.screenRect[3];
    // width は「画面幅が覆うテクスチャの U 幅」なので、路面の画面上の幅はその逆数に比例する
    for (let row = 1; row < rows; row++) {
      expect(surface.scanlines[row * 4 + 1]!).toBeLessThan(surface.scanlines[(row - 1) * 4 + 1]!);
    }
  });

  it('最遠の路面が画面幅の 2 割以下まで細くなる', () => {
    // エンジンは width ≤ 1 を強制するため、路面は roadFraction × 画面幅 より細くならない。
    // 同梱の road.png（路面が 44.5%）では 114 px で止まり「奥に進む」感が出ない
    const farPx = farRoadWidthPx(PROFILE);
    expect(roadFraction()).toBeCloseTo(12 / ROAD_SURFACE.spanMeters, 6);
    expect(farPx).toBeLessThanOrEqual(PROFILE.video.internalWidth * 0.2);
  });

  it('前方の路面ほど暗く、走査線ごとの縞が乗っている', () => {
    const surface = buildFrame('FC', raceAfter(1500)).rasterSurfaces[0]!;
    const rows = surface.screenRect[3];
    const brightnessAt = (row: number) => surface.scanlines[row * 4 + 3]!;
    // 偶数行どうしで比べる（奇数行には縞が乗っているため）
    expect(brightnessAt(rows - 2)).toBeGreaterThan(brightnessAt(0));
    let striped = 0;
    for (let row = 1; row < rows; row += 2) {
      if (brightnessAt(row) < brightnessAt(row - 1)) striped += 1;
    }
    expect(striped).toBeGreaterThan(rows / 4);
  });

  it('コーナーでは路面の中心が画面の横方向へ流れる', () => {
    // ヘアピンを含む区間で、遠方行の center が近距離行から明確にずれること
    const offsets = MOMENTS.map((ticks) => {
      const surface = buildFrame('FC', raceAfter(ticks)).rasterSurfaces[0]!;
      const rows = surface.screenRect[3];
      return Math.abs(surface.scanlines[0]! - surface.scanlines[(rows - 1) * 4]!);
    });
    expect(Math.max(...offsets)).toBeGreaterThan(0.05);
  });

  it('速度が上がるほど V 位相の進みが大きい（センターラインの流れが速度に対応する）', () => {
    const state = raceAfter(1500);
    const player = state.cars[0]!;
    const view = (speedS: number) =>
      createRoadView({
        profile: PROFILE,
        camera: FC_CAMERA,
        track: TRACK,
        car: { ...player, s: TRACK.wrapS(player.s + speedS) },
      });

    const base = view(0).sourceVAt(20);
    const slow = view(4).sourceVAt(20);
    const fast = view(12).sourceVAt(20);
    const advance = (value: number) => (value - base + 1) % 1;
    expect(advance(slow)).toBeCloseTo(4 / ROAD_SURFACE.periodMeters, 6);
    expect(advance(fast)).toBeGreaterThan(advance(slow));
  });
});
