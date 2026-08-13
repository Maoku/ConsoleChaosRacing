import { GENERATION_IDS, generationValue } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { createTrack } from '../src/game/sim/track.js';
import { STEER_FRAME, steerCellOffset } from '../src/game/view/shared/car-sprite.js';

/**
 * ステアフレームの選び方（実装計画 8-1）。
 *
 * 直線を走っているのに絵が左右の傾きセルへ切り替わっていた。原因は判定が
 * 横加速度だけだったことで、直線でも自機の小さな修正舵と AI の車線取りが
 * 閾値を跨ぎ、6Hz / 12Hz の量子化と重なって「パタパタ切り替わる」見え方になる。
 *
 * ここで固定するのは 2 つ。
 *
 * 1. **直線区間では最大舵・最大横加速度でも正面のまま**（曲率の門が効いている）
 * 2. **カーブでは横加速度の符号どおりの側**を返す（列 0 = 右コーナー・§3.2）
 *
 * 曲率は実際のコース（`track.ts`）から引く。閾値を「コースにありえない値」に
 * してしまうと門が常時開くか常時閉じるかになるので、**実コースの区間で確かめる**。
 */

const track = createTrack();
const THRESHOLDS = generationValue(STEER_FRAME, 'FC');

/** 実コースの中でいちばん真っ直ぐな場所と、いちばん曲がっている場所 */
function extremes() {
  let straight = track.samples[0]!;
  let corner = track.samples[0]!;
  for (const sample of track.samples) {
    if (Math.abs(sample.curvature) < Math.abs(straight.curvature)) straight = sample;
    if (Math.abs(sample.curvature) > Math.abs(corner.curvature)) corner = sample;
  }
  return { straight, corner };
}

function car(lateralAccel: number) {
  return { lateralAccel };
}

describe('ステアフレーム', () => {
  const { straight, corner } = extremes();

  it('コースには門の両側の区間が実在する', () => {
    // 閾値がコースの曲率の外にあると、この検査そのものが意味を失う
    expect(Math.abs(straight.curvature)).toBeLessThan(THRESHOLDS.curvature);
    expect(Math.abs(corner.curvature)).toBeGreaterThan(THRESHOLDS.curvature);
  });

  it('直線区間では最大の横加速度でも正面のセルを返す', () => {
    for (const accel of [0, 3.5, 9, 40, -3.5, -9, -40]) {
      expect(steerCellOffset(car(accel), straight.curvature, THRESHOLDS), `${accel} m/s²`).toBe(1);
    }
  });

  it('カーブでは横加速度の符号どおりの側を返す', () => {
    // 列 0 はノーズが右を向いた絵。横加速度が右向き（正）＝右コーナー
    expect(steerCellOffset(car(9), corner.curvature, THRESHOLDS)).toBe(0);
    expect(steerCellOffset(car(-9), corner.curvature, THRESHOLDS)).toBe(2);
    // 曲率が高くても、舵が当たっていなければ正面のまま（AND ゲートの片側）
    expect(steerCellOffset(car(0), corner.curvature, THRESHOLDS)).toBe(1);
  });

  it('カーブの中でも小さな修正舵では傾かない', () => {
    // 閾値を 3.5 → 5.0 へ上げたぶん。コーナリング中の微修正で絵が揺れない
    expect(steerCellOffset(car(4.2), corner.curvature, THRESHOLDS)).toBe(1);
    expect(steerCellOffset(car(-4.2), corner.curvature, THRESHOLDS)).toBe(1);
  });

  it('ヒステリシスを持たない（同じ入力なら常に同じセル）', () => {
    // ビューは状態を持たない純関数（§2.1）。二重閾値ではなく AND ゲートで解決している
    const sequence = [0, 6, 0, -6, 0, 6].map((accel) =>
      steerCellOffset(car(accel), corner.curvature, THRESHOLDS),
    );
    expect(sequence).toEqual([1, 0, 1, 2, 1, 0]);
  });

  it('閾値は 4 世代ぶん定義されている（ビューに世代 ID 分岐を書かないため）', () => {
    for (const generation of GENERATION_IDS) {
      const thresholds = generationValue(STEER_FRAME, generation);
      expect(thresholds.lateralAccel).toBeGreaterThan(0);
      expect(thresholds.curvature).toBeGreaterThan(0);
    }
  });
});
