import type { CarState, RaceState } from './state.js';
import type { Track } from './track.js';
import {
  VEHICLE,
  cornerSpeedLimit,
  gripAccel,
  steeringLimits,
  topSpeedOf,
  type VehicleControl,
} from './vehicle.js';

/**
 * AI ドライバ（実装計画 §5.3）。
 *
 * 「理想ライン ＋ 個体差 ＋ 前方車回避」の 3 つだけ。乱数は使わず、
 * 個体差は `CarState` に焼き込まれた定数（`skill` / `lineBias` / `reactionTicks`）で表す。
 * 同一シードなら完全に同じ走りになる。
 */

const AI = {
  /** 先読み距離の基本値 [m] */
  LOOKAHEAD_BASE: 14,
  /** 速度あたりの先読み距離 [s] */
  LOOKAHEAD_TIME: 0.55,
  /** 制動判定でコースを走査する刻み [m] */
  SCAN_STEP: 6,
  /** 制動判定の最大先読み [m] */
  SCAN_MAX: 260,
  /** コーナー進入速度の安全率 */
  CORNER_SAFETY: 0.94,
  /** 理想ラインが縁石へ寄りきる曲率 */
  LINE_FULL_CURVATURE: 0.02,
  /** 縁石から残す余裕 [m] */
  LINE_MARGIN: 1.4,
  /** 横位置の誤差 1 m あたりの目標ヨー角 [rad] */
  YAW_PER_METER: 0.055,
  /** 目標ヨー角へ寄せる速さ [1/s] */
  YAW_GAIN: 3.2,
  /** 回避を始める前方距離 [m] */
  AVOID_AHEAD: 26,
  /** 回避すると判断する横方向の近さ [m] */
  AVOID_LATERAL: 3.4,
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/** コーナーの内側へ寄せた理想ラインの横位置 [m] */
function racingLineAt(track: Track, s: number, bias: number): number {
  const sample = track.sampleAt(s);
  const reach = sample.halfWidth - AI.LINE_MARGIN;
  const strength = clamp(Math.abs(sample.curvature) / AI.LINE_FULL_CURVATURE, 0, 1);
  // 曲率が左正なので、左コーナーの内側は左（lateral が負）
  const inside = -Math.sign(sample.curvature) * reach * strength;
  return clamp(inside + bias, -reach, reach);
}

/**
 * 前方のコーナーから逆算した進入速度 [m/s]。
 * 各地点で曲がりきれる速度に、そこまでの制動距離ぶんを足し戻して最小を取る。
 */
function targetSpeedFor(track: Track, car: CarState): number {
  // 路外に出ていても「本来のライン」を基準に計画する。路外のグリップで計画すると
  // 草地で止まってしまい、コースへ戻れなくなる（罰は物理側が与える）
  const grip = gripAccel(0) * AI.CORNER_SAFETY;
  let target: number = topSpeedOf(car);
  for (let distance = 0; distance <= AI.SCAN_MAX; distance += AI.SCAN_STEP) {
    const sample = track.sampleAt(car.s + distance);
    const cornerLimit = cornerSpeedLimit(sample.curvature, grip);
    const entrySpeed = Math.sqrt(
      cornerLimit * cornerLimit + 2 * VEHICLE.BRAKE_ACCEL * 0.85 * distance,
    );
    if (entrySpeed < target) target = entrySpeed;
  }
  return target * car.skill;
}

/** 前方に詰まっている車を避けるための横方向のずらし量 [m] */
function avoidanceOffset(state: RaceState, car: CarState): number {
  const track = state.track;
  let offset = 0;
  for (const other of state.cars) {
    if (other.entrant === car.entrant) continue;
    const gap = track.deltaS(other.s, car.s);
    if (gap <= 0 || gap > AI.AVOID_AHEAD) continue;
    const lateralGap = other.lateral - car.lateral;
    if (Math.abs(lateralGap) > AI.AVOID_LATERAL) continue;
    // 近いほど強く、内側が空いていればそちらへ逃げる
    const urgency = 1 - gap / AI.AVOID_AHEAD;
    const direction = lateralGap >= 0 ? -1 : 1;
    offset += direction * urgency * 3.2;
  }
  return clamp(offset, -4.5, 4.5);
}

/**
 * 1 ティックぶんの AI 操作を決める。
 *
 * `reactionTicks` は「何ティック前のコースを見て走るか」で表す。
 * 反応が鈍いドライバはコーナーの認識が遅れ、ラインが膨らむ。
 */
export function driveAi(state: RaceState, car: CarState): VehicleControl {
  const track = state.track;

  if (state.phase === 'countdown') {
    return { steer: 0, throttle: 0, brake: 0 };
  }
  if (car.finished) {
    // 完走後はクールダウン。コース上に留まりつつ減速する
    return { steer: steerToward(track, car, racingLineAt(track, car.s, car.lineBias)), throttle: 0, brake: 0.35 };
  }

  const lookahead = AI.LOOKAHEAD_BASE + car.speed * AI.LOOKAHEAD_TIME;
  const delay = car.reactionTicks * car.speed * (1 / 60);
  const targetLateral = clamp(
    racingLineAt(track, car.s + lookahead - delay, car.lineBias) + avoidanceOffset(state, car),
    -(track.sampleAt(car.s).halfWidth - 0.6),
    track.sampleAt(car.s).halfWidth - 0.6,
  );

  const steer = steerToward(track, car, targetLateral);
  const targetSpeed = targetSpeedFor(track, car);

  let throttle = 0;
  let brake = 0;
  if (car.speed < targetSpeed - 1) {
    throttle = 1;
  } else if (car.speed > targetSpeed + 1) {
    brake = clamp((car.speed - targetSpeed) / 7, 0.15, 1);
  } else {
    throttle = 0.55;
  }

  return { steer, throttle, brake };
}

/** 目標の横位置へ向かうための操舵量 -1..1 */
function steerToward(track: Track, car: CarState, targetLateral: number): number {
  const sample = track.sampleAt(car.s);
  const error = targetLateral - car.lateral;
  const desiredYaw = clamp(error * AI.YAW_PER_METER, -0.32, 0.32);
  // コース接線に追従するぶん（-κv）＋ 目標ヨー角へ寄せるぶん
  const desiredYawRate =
    -sample.curvature * car.speed + (desiredYaw - car.yaw) * AI.YAW_GAIN;
  // 路外の手心（戻り舵のグリップ）も含めた限界。`stepVehicle` と同じ関数を通す
  const limits = steeringLimits(
    car.speed,
    car.lateral,
    sample.halfWidth,
    Math.sign(desiredYawRate),
  );
  if (limits.authority < 1e-4) return 0;
  // グリップを超える舵は切らない（AI は自分から滑らせない）
  const held = clamp(desiredYawRate, -limits.gripYawRate, limits.gripYawRate);
  return clamp(held / limits.authority, -1, 1);
}
