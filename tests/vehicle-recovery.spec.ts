import { FIXED_DT_SECONDS } from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { TRACK } from '../src/game/sim/track.js';
import type { CarState } from '../src/game/sim/state.js';
import { createRaceState } from '../src/game/sim/state.js';
import { WALL, wallMaterialAt } from '../src/game/sim/wall.js';
import {
  VEHICLE,
  wallLateral,
  gripAccel,
  offTrackSeverity,
  stepVehicle,
  steeringLimits,
  yawAuthority,
  type VehicleControl,
} from '../src/game/sim/vehicle.js';

/**
 * コースアウトからの復帰（実装計画 9-1）。
 *
 * 直したのは 3 つで、**どれも速度の罰は減らしていない**（路外が近道になってはいけない）。
 *
 * 1. **壁が車を離す。** 以前は当たると位置を壁ちょうどへ留め、ヨーを向きに関わらず
 *    0.3 倍にし、速度を 14 m/s で頭打ちにしていた。内向きの舵でヨーが育たないまま
 *    未達ヨーの横滑りが外向きに勝つので、**全開＋フル戻り舵でも壁から離れられなかった**
 * 2. **戻り舵にだけグリップを返す**（`RECOVERY_GRIP`）
 * 3. **路外の罰を深さで段階化する**（`offTrackSeverity`）。浅いミスは浅く罰する
 *
 * 路面の上での挙動は 1 ビットも変えていない。それを最後の 2 件で固定する。
 */

const dt = FIXED_DT_SECONDS;

/** 壁に当たったか。材質は問わない（11-4 で `hitKind` が材質を持つようになった） */
function isWall(kind: string): boolean {
  return kind === 'concrete' || kind === 'tyre';
}
const FULL_THROTTLE_BACK = (side: number): VehicleControl => ({
  steer: -side,
  throttle: 1,
  brake: 0,
});

/** 直線区間（曲率がほぼ 0）の弧長 */
const STRAIGHT_S = TRACK.samples.find((sample) => Math.abs(sample.curvature) < 1e-4)!.s;
/** 最も急なコーナーの弧長 */
const CORNER_S = TRACK.samples.reduce((worst, sample) =>
  Math.abs(sample.curvature) > Math.abs(worst.curvature) ? sample : worst,
).s;

function carAt(s: number, lateral: number, speed: number, yaw = 0): CarState {
  const car = createRaceState().cars[0]!;
  car.s = s;
  car.lateral = lateral;
  car.speed = speed;
  car.yaw = yaw;
  car.offTrack = Math.abs(lateral) > TRACK.sampleAt(s).halfWidth;
  return car;
}

/** 路面へ戻るまでの秒数。戻れなければ `Infinity` */
function secondsToRecover(car: CarState, seconds = 20): number {
  const side = Math.sign(car.lateral) || 1;
  for (let tick = 0; tick < Math.round(seconds / dt); tick++) {
    stepVehicle(car, FULL_THROTTLE_BACK(side), TRACK, dt);
    if (!car.offTrack) return (tick + 1) * dt;
  }
  return Infinity;
}

describe('コースアウトからの復帰', () => {
  it('壁ぎわからでも全開＋戻り舵で数秒で路面へ戻れる', () => {
    // 回帰: 以前はこの条件で 30 秒回しても壁に貼り付いたままだった。
    // ほぼ止まった状態からは舵が効かないぶん時間が掛かる（`YAW_SPEED_REF`）
    for (const s of [STRAIGHT_S, CORNER_S]) {
      const limit = wallLateral(TRACK.sampleAt(s).halfWidth);
      for (const side of [1, -1]) {
        for (const speed of [3, 14, 40, 70]) {
          const car = carAt(s, side * limit, speed);
          const took = secondsToRecover(car);
          const where = `s=${s.toFixed(0)} side=${side} speed=${speed}`;
          expect(took, where).toBeLessThan(speed < 10 ? 6 : 5);
          // 戻ったあとは走れる速度が残っている
          expect(car.speed, where).toBeGreaterThan(5);
        }
      }
    }
  });

  it('コース 1 周のどこで壁ぎわに落ちても復帰できる', () => {
    // 20 m 刻みで全周 × 左右 × 4 つの速度。**戻れない地点が 1 つも無い**ことが要点で、
    // 速いコーナーの外側では「先に速度を落とさないと戻れない」ぶん時間が伸びる
    // （曲率が要求するヨー角速度がグリップを超えるため。ブレーキを併用すれば縮む）
    const times: number[] = [];
    for (let s = 0; s < TRACK.length; s += 20) {
      const limit = wallLateral(TRACK.sampleAt(s).halfWidth);
      for (const side of [1, -1]) {
        for (const speed of [3, 14, 40, 70]) {
          const took = secondsToRecover(carAt(s, side * limit, speed));
          expect(took, `s=${s} side=${side} speed=${speed}`).toBeLessThan(12);
          times.push(took);
        }
      }
    }
    times.sort((a, b) => a - b);
    expect(times[times.length >> 1]!).toBeLessThan(3);
  });

  it('壁に当たった車は壁より内側へ置かれる（貼り付かない）', () => {
    const car = carAt(STRAIGHT_S, TRACK.sampleAt(STRAIGHT_S).halfWidth - 1, 60, 0.4);
    let hits = 0;
    for (let tick = 0; tick < 60 * 3; tick++) {
      stepVehicle(car, { steer: 0.4, throttle: 1, brake: 0 }, TRACK, dt);
      if (!isWall(car.hitKind)) continue;
      hits += 1;
      const limit = wallLateral(TRACK.sampleAt(car.s).halfWidth);
      expect(Math.abs(car.lateral)).toBeLessThan(limit);
      const material = wallMaterialAt(TRACK, car.s, car.lateral > 0 ? 1 : -1);
      expect(Math.abs(car.lateral)).toBeCloseTo(limit - WALL[material].bounce, 6);
      // 外を向いたヨーは殺される
      expect(car.yaw).toBeLessThan(0.4);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it('壁へ舵を当て続けても接触が毎ティックにはならない（接触音が連射にならない）', () => {
    const limit = wallLateral(TRACK.sampleAt(STRAIGHT_S).halfWidth);
    const car = carAt(STRAIGHT_S, limit - 1, 30);
    let contactTicks = 0;
    const ticks = 60 * 5;
    for (let tick = 0; tick < ticks; tick++) {
      stepVehicle(car, { steer: 1, throttle: 1, brake: 0 }, TRACK, dt);
      if (isWall(car.hitKind)) contactTicks += 1;
    }
    expect(contactTicks).toBeGreaterThan(0);
    expect(contactTicks / ticks).toBeLessThan(0.1);
  });

  it('壁の速度の罰は当たりの強さに比例し、掠りにも下限がある（11-4 / D-10）', () => {
    const limit = wallLateral(TRACK.sampleAt(STRAIGHT_S).halfWidth);
    // 舵を当てずに壁へ寄せ、当たった 1 ティックで削られた速度を測る
    const lossFor = (yaw: number): number => {
      const car = carAt(STRAIGHT_S, limit - 0.5, 60, yaw);
      for (let tick = 0; tick < 60 * 2; tick++) {
        const before = car.speed;
        stepVehicle(car, { steer: 0, throttle: 1, brake: 0 }, TRACK, dt);
        if (isWall(car.hitKind)) return before - car.speed;
      }
      throw new Error(`yaw ${yaw} で壁へ届かなかった`);
    };
    const graze = lossFor(0.02);
    const solid = lossFor(0.2);
    const slam = lossFor(0.6);
    // 掠りは下限（速度の 8 %）で決まる。改修前は −0.5 m/s ＝ 1 % しか削れておらず、
    // 「壁を舐めながら走る」のがいちばん速いラインだった
    expect(graze).toBeGreaterThan(50 * WALL.concrete.minimumLoss);
    expect(graze).toBeLessThan(60 * WALL.concrete.minimumLoss + 0.1);
    // 強く当たれば下限を超えて `bite` が効く
    expect(solid).toBeGreaterThan(graze * 2);
    expect(slam).toBeGreaterThan(solid * 2);
  });

  it('路外の罰は深さに比例し、縁を割った直後は浅い', () => {
    const half = TRACK.sampleAt(STRAIGHT_S).halfWidth;
    expect(offTrackSeverity(half - 0.1, half)).toBe(0);
    expect(offTrackSeverity(half, half)).toBe(0);
    expect(offTrackSeverity(half + 0.01, half)).toBeCloseTo(VEHICLE.OFF_TRACK_MIN_SEVERITY, 2);
    expect(offTrackSeverity(half + VEHICLE.OFF_TRACK_FULL_DEPTH, half)).toBeCloseTo(1, 12);
    expect(offTrackSeverity(-(half + VEHICLE.RUNOFF), half)).toBe(1);

    // 深さが増えるほど単調に厳しくなる（グリップは下がる）
    let previousSeverity = -1;
    let previousGrip = Infinity;
    for (let depth = 0.1; depth <= VEHICLE.RUNOFF; depth += 0.1) {
      const severity = offTrackSeverity(half + depth, half);
      expect(severity).toBeGreaterThanOrEqual(previousSeverity);
      const grip = gripAccel(severity);
      expect(grip).toBeLessThanOrEqual(previousGrip);
      previousSeverity = severity;
      previousGrip = grip;
    }
    expect(gripAccel(1)).toBeCloseTo(VEHICLE.GRIP_ACCEL * VEHICLE.OFF_TRACK_GRIP, 6);
  });

  it('戻り舵にだけグリップが返る（外へ向ける舵は草地のまま）', () => {
    const half = TRACK.sampleAt(STRAIGHT_S).halfWidth;
    const lateral = half + 4; // 右の草地の奥（罰は最大）
    const back = steeringLimits(30, lateral, half, -1); // 左 ＝ 路面の側
    const out = steeringLimits(30, lateral, half, 1); // 右 ＝ さらに外
    expect(back.grip).toBeCloseTo(VEHICLE.GRIP_ACCEL * VEHICLE.RECOVERY_GRIP, 6);
    expect(out.grip).toBeCloseTo(VEHICLE.GRIP_ACCEL * VEHICLE.OFF_TRACK_GRIP, 6);
    expect(back.authority).toBeGreaterThan(out.authority);

    // 左の草地なら符号が入れ替わる
    const mirrored = steeringLimits(30, -lateral, half, 1);
    expect(mirrored.grip).toBeCloseTo(back.grip, 6);
  });

  it('路外は依然として近道にならない', () => {
    const half = TRACK.sampleAt(STRAIGHT_S).halfWidth;
    const terminal = (lateral: number): number => {
      const car = carAt(STRAIGHT_S, lateral, 0);
      for (let tick = 0; tick < 60 * 10; tick++) {
        stepVehicle(car, { steer: 0, throttle: 1, brake: 0 }, TRACK, dt);
      }
      return car.speed;
    };
    const onTrack = terminal(0);
    const grass = terminal(half + 4);
    expect(onTrack).toBeGreaterThan(45);
    expect(grass).toBeLessThan(onTrack * 0.4);
  });

  it('路面の上では手心が一切掛からない', () => {
    const half = TRACK.sampleAt(STRAIGHT_S).halfWidth;
    for (const speed of [0, 8, 20, 40, 78]) {
      for (const lateral of [0, 2, -half, half]) {
        for (const steer of [-1, 0, 1]) {
          const limits = steeringLimits(speed, lateral, half, steer);
          expect(limits.grip).toBe(VEHICLE.GRIP_ACCEL);
          expect(limits.authority).toBe(yawAuthority(speed, VEHICLE.GRIP_ACCEL));
        }
      }
    }
  });

  it('路面の縁までは罰がまったく掛からない', () => {
    // 減速の罰は `offTrackSeverity` を通してしか掛からないので、
    // 路面上の走りは以前の式（路外の項が消えた形）とそのまま一致する
    for (const sample of TRACK.samples) {
      expect(offTrackSeverity(sample.halfWidth, sample.halfWidth)).toBe(0);
      expect(offTrackSeverity(-sample.halfWidth, sample.halfWidth)).toBe(0);
    }
  });
});
