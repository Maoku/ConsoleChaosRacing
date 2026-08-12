import { describe, expect, it } from 'vitest';

import { TRACK, createTrack } from '../src/game/sim/track.js';
import {
  DEFAULT_HALF_WIDTH,
  TRACK_CONTROL_POINTS,
  WIDE_HALF_WIDTH,
} from '../src/game/sim/track-data.js';

const TAU = Math.PI * 2;

function wrapAngle(angle: number): number {
  return angle - TAU * Math.floor((angle + Math.PI) / TAU);
}

describe('トラック空間', () => {
  it('閉ループになっている', () => {
    const first = TRACK.samples[0]!;
    const last = TRACK.samples[TRACK.samples.length - 1]!;
    const gap = Math.hypot(
      first.position[0] - last.position[0],
      first.position[2] - last.position[2],
    );
    // 末尾のサンプルは 1 サンプルぶん手前にある。そこから始点までがちょうど間隔ぶん
    expect(gap).toBeGreaterThan(TRACK.spacing * 0.9);
    expect(gap).toBeLessThan(TRACK.spacing * 1.1);

    // 標高・半幅・バンクも連続している
    expect(Math.abs(first.position[1] - last.position[1])).toBeLessThan(0.05);
    expect(Math.abs(first.halfWidth - last.halfWidth)).toBeLessThan(0.05);
    expect(Math.abs(wrapAngle(first.heading - last.heading))).toBeLessThan(0.05);
  });

  it('弧長が単調に増え、サンプル間隔が一定である', () => {
    for (let index = 1; index < TRACK.samples.length; index++) {
      const previous = TRACK.samples[index - 1]!;
      const current = TRACK.samples[index]!;
      expect(current.s).toBeGreaterThan(previous.s);
      const step = Math.hypot(
        current.position[0] - previous.position[0],
        current.position[2] - previous.position[2],
      );
      // 弧長でリサンプリングしているので、直線距離は間隔をわずかに下回るだけ
      expect(step).toBeGreaterThan(TRACK.spacing * 0.98);
      expect(step).toBeLessThanOrEqual(TRACK.spacing * 1.02);
    }
  });

  it('toWorld ∘ toTrack の往復誤差が 1 mm 未満', () => {
    let worst = 0;
    for (let index = 0; index < 2000; index++) {
      const s = (index / 2000) * TRACK.length;
      const lateral = ((index % 17) / 17 - 0.5) * 12;
      const world = TRACK.toWorld(s, lateral);
      const back = TRACK.toTrack(world[0], world[2]);
      worst = Math.max(
        worst,
        Math.abs(TRACK.deltaS(back.s, s)),
        Math.abs(back.lateral - lateral),
      );
    }
    expect(worst).toBeLessThan(0.001);
  });

  it('hintS を渡しても同じ解になる', () => {
    for (let index = 0; index < 500; index++) {
      const s = (index / 500) * TRACK.length;
      const lateral = ((index % 7) / 7 - 0.5) * 10;
      const world = TRACK.toWorld(s, lateral);
      const hinted = TRACK.toTrack(world[0], world[2], s + 12);
      expect(Math.abs(TRACK.deltaS(hinted.s, s))).toBeLessThan(0.001);
      expect(Math.abs(hinted.lateral - lateral)).toBeLessThan(0.001);
    }
  });

  it('1 周で向きがちょうど 1 回転する', () => {
    let turn = 0;
    for (let index = 0; index < TRACK.samples.length; index++) {
      const current = TRACK.samples[index]!;
      const next = TRACK.samples[(index + 1) % TRACK.samples.length]!;
      turn += wrapAngle(next.heading - current.heading);
    }
    // 右回りのコースなので heading は +2π ぶん回る（curvature は左正なので主に負）
    expect(turn).toBeCloseTo(TAU, 3);
  });

  it('コース仕様（§2.3）を満たす', () => {
    expect(TRACK.length).toBeGreaterThan(2800);
    expect(TRACK.length).toBeLessThan(3300);

    let minHalfWidth = Infinity;
    let maxHalfWidth = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    let maxBank = 0;
    let minRadius = Infinity;
    for (const sample of TRACK.samples) {
      minHalfWidth = Math.min(minHalfWidth, sample.halfWidth);
      maxHalfWidth = Math.max(maxHalfWidth, sample.halfWidth);
      minY = Math.min(minY, sample.position[1]);
      maxY = Math.max(maxY, sample.position[1]);
      maxBank = Math.max(maxBank, Math.abs(sample.bank));
      if (sample.curvature !== 0) {
        minRadius = Math.min(minRadius, 1 / Math.abs(sample.curvature));
      }
    }

    expect(minHalfWidth).toBeGreaterThanOrEqual(DEFAULT_HALF_WIDTH - 0.01);
    expect(maxHalfWidth).toBeLessThanOrEqual(WIDE_HALF_WIDTH + 0.01);
    expect(maxY - minY).toBeLessThanOrEqual(8.5);
    expect(maxBank).toBeLessThanOrEqual((4 * Math.PI) / 180 + 1e-6);
    // 最も遅いコーナーでも、アーケード寄りの車が曲がれる半径を残す
    expect(minRadius).toBeGreaterThan(18);
  });

  it('bounds が路上のすべての点を含む', () => {
    const { min, max } = TRACK.bounds;
    for (let index = 0; index < TRACK.samples.length; index += 7) {
      const sample = TRACK.samples[index]!;
      for (const lateral of [-sample.halfWidth, 0, sample.halfWidth]) {
        const world = TRACK.toWorld(sample.s, lateral);
        expect(world[0]).toBeGreaterThanOrEqual(min[0]);
        expect(world[0]).toBeLessThanOrEqual(max[0]);
        expect(world[2]).toBeGreaterThanOrEqual(min[1]);
        expect(world[2]).toBeLessThanOrEqual(max[1]);
      }
    }
    expect(TRACK.bounds.size[0]).toBeCloseTo(max[0] - min[0], 9);
    expect(TRACK.bounds.size[1]).toBeCloseTo(max[1] - min[1], 9);
  });

  it('曲率は左が正 — ヘアピンは右コーナーなので負になる', () => {
    // ヘアピンの頂点は制御点 (108, 420) の近く
    const apex = TRACK.toTrack(108, 420);
    const sample = TRACK.sampleAt(apex.s);
    expect(sample.curvature).toBeLessThan(-0.02);
    // 曲率の符号と右方向の定義が整合している: +X を向いていれば右は +Z
    const straight = TRACK.sampleAt(TRACK.wrapS(150));
    expect(straight.tangent[0]).toBeGreaterThan(0.98);
    expect(straight.right[1]).toBeGreaterThan(0.98);
  });

  it('s の正規化と最短差が周回を跨いでも正しい', () => {
    expect(TRACK.wrapS(-1)).toBeCloseTo(TRACK.length - 1, 6);
    expect(TRACK.wrapS(TRACK.length + 5)).toBeCloseTo(5, 6);
    expect(TRACK.deltaS(2, TRACK.length - 2)).toBeCloseTo(4, 6);
    expect(TRACK.deltaS(TRACK.length - 2, 2)).toBeCloseTo(-4, 6);
  });

  it('リサンプリング間隔を変えても形が一致する', () => {
    const coarse = createTrack(TRACK_CONTROL_POINTS, { spacing: 4 });
    expect(Math.abs(coarse.length - TRACK.length)).toBeLessThan(0.5);
    for (let index = 0; index < 200; index++) {
      const s = (index / 200) * TRACK.length;
      const fine = TRACK.toWorld(s, 0);
      const rough = coarse.toWorld(s, 0);
      expect(Math.hypot(fine[0] - rough[0], fine[2] - rough[2])).toBeLessThan(0.3);
    }
  });
});
