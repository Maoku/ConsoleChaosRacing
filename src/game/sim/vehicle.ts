import type { CarState } from './state.js';
import type { Track } from './track.js';

/**
 * 車両モデル（実装計画 §5.3）。アーケード寄り。
 *
 * 状態は「弧長 s ／ 横位置 lateral ／ 速度 ／ 接線に対するヨー角」の 4 つだけで、
 * ワールド座標は `track.toWorld()` から常に導出する。これにより
 * 「シミュレーションは 1 つ」がデータ構造の水準で保証される。
 *
 * 符号の規約は `track.ts` に合わせる: 右が正、曲率は左が正。
 */
export interface VehicleControl {
  /** -1..1。右が正 */
  steer: number;
  /** 0..1 */
  throttle: number;
  /** 0..1 */
  brake: number;
}

export const VEHICLE = {
  /** 最高速度 [m/s]（≒ 280 km/h） */
  MAX_SPEED: 78,
  /** 低速時の加速度 [m/s²]。速度が上がるほど鈍る */
  ACCEL: 11,
  /** 制動加速度 [m/s²] */
  BRAKE_ACCEL: 22,
  /** 惰行時の抵抗 [m/s²] */
  COAST_DRAG: 3,
  /** 路面のグリップが許す横加速度 [m/s²] */
  GRIP_ACCEL: 15,
  /** 路外のグリップ倍率 */
  OFF_TRACK_GRIP: 0.45,
  /** 路外の追加抵抗 [m/s²] */
  OFF_TRACK_DRAG: 9,
  /** 最大ヨー角速度 [rad/s] */
  MAX_YAW_RATE: 1.6,
  /** ヨーの効きが半分になる速度 [m/s]。低速では舵が効かない */
  YAW_SPEED_REF: 10,
  /**
   * グリップの何倍まで舵を切れるか。
   * 実車の舵角はタイヤが流れる以上には効かない。この上限が無いと、
   * 高速でフルロックしたときに要求と実現の差が発散して一瞬でコース外へ飛ぶ。
   */
  OVERSTEER_FACTOR: 1.35,
  /** 進行方向が車体へ揃おうとする速さ [1/s] */
  YAW_DAMPING: 2.6,
  /** グリップを超えた操舵要求が横滑りへ変わる時定数 [s] */
  SLIDE_TIME: 0.28,
  /** 横滑り中のタイヤ抵抗 [1/s] */
  SCRUB: 0.55,
  /** 路面外側の走行可能域（草地）[m] */
  RUNOFF: 9,
  /** 壁に当たったあとの速度上限 [m/s] */
  WALL_SPEED: 14,
} as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * その速度で出せる最大ヨー角速度 [rad/s]。
 *
 * 低速では舵が効かず（車が動いていないと向きは変わらない）、
 * 高速ではグリップが頭を押さえる。上限をグリップの `OVERSTEER_FACTOR` 倍に留めるので、
 * 「限界より 35% 速い」までしか無理は利かない。
 */
export function yawAuthority(speed: number, grip: number = VEHICLE.GRIP_ACCEL): number {
  const steering = (VEHICLE.MAX_YAW_RATE * speed) / (speed + VEHICLE.YAW_SPEED_REF);
  const gripLimited = (VEHICLE.OVERSTEER_FACTOR * grip) / Math.max(speed, 8);
  return Math.min(steering, gripLimited);
}

/** 路面状態に応じたグリップ [m/s²] */
export function gripAccel(offTrack: boolean): number {
  return offTrack ? VEHICLE.GRIP_ACCEL * VEHICLE.OFF_TRACK_GRIP : VEHICLE.GRIP_ACCEL;
}

/** 曲率 κ のコーナーを曲がりきれる最大速度 [m/s] */
export function cornerSpeedLimit(curvature: number, grip: number = VEHICLE.GRIP_ACCEL): number {
  const magnitude = Math.abs(curvature);
  if (magnitude < 1e-6) return VEHICLE.MAX_SPEED;
  return Math.sqrt(grip / magnitude);
}

/**
 * 1 ティックぶん車を進める。`car` を破壊的に更新する。
 *
 * 遠心力は独立した項ではなく、**グリップで頭打ちになった操舵要求の不足分**として現れる。
 * コーナーで踏みすぎると要求ヨー角速度がグリップ上限を超え、その差が外側への
 * 横滑りになる。要求どおり曲がれている間は滑らない。
 */
export function stepVehicle(
  car: CarState,
  control: VehicleControl,
  track: Track,
  dt: number,
): void {
  const sample = track.sampleAt(car.s);
  const previousSpeed = car.speed;

  const steer = clamp(control.steer, -1, 1);
  const throttle = clamp(control.throttle, 0, 1);
  const brake = clamp(control.brake, 0, 1);
  car.steerInput = steer;
  car.throttleInput = throttle;
  car.brakeInput = brake;

  // ── 速度: 目標速度への一次遅れ ＋ 抵抗
  const targetSpeed = VEHICLE.MAX_SPEED * throttle;
  let acceleration: number;
  if (brake > 0) {
    acceleration = -VEHICLE.BRAKE_ACCEL * brake;
  } else if (targetSpeed > car.speed) {
    acceleration = VEHICLE.ACCEL * (1 - car.speed / VEHICLE.MAX_SPEED);
  } else {
    acceleration = -VEHICLE.COAST_DRAG;
  }
  if (car.offTrack) acceleration -= VEHICLE.OFF_TRACK_DRAG;

  // バンクは坂と同じで、上り勾配ぶんの減速になる（第3・第4世代の起伏が走りに出る）
  const slope = -Math.sin(Math.atan(gradientAt(track, car.s))) * 9.81;
  acceleration += slope;

  car.speed = Math.max(0, car.speed + acceleration * dt);

  // ── 操舵: 要求ヨー角速度をグリップで頭打ちにする
  const grip = gripAccel(car.offTrack);
  const authority = yawAuthority(car.speed, grip);
  const demandedYawRate = steer * authority;
  const gripYawRate = car.speed > 0.5 ? grip / car.speed : authority;
  const yawRate = clamp(demandedYawRate, -gripYawRate, gripYawRate);
  const unmetYawRate = demandedYawRate - yawRate;

  // ── ヨー角（コース接線に対する相対角）
  const advance = car.speed * Math.cos(car.yaw);
  car.yaw += (yawRate + sample.curvature * advance - car.yaw * VEHICLE.YAW_DAMPING) * dt;
  car.yaw = clamp(car.yaw, -1.2, 1.2);

  // ── 位置。滑りは曲がりきれなかったぶんだけ外へ出る
  const slide = -unmetYawRate * car.speed * VEHICLE.SLIDE_TIME;
  car.s = track.wrapS(car.s + advance * dt);
  car.lateral += (car.speed * Math.sin(car.yaw) + slide) * dt;

  // ── タイヤの引きずりで速度が落ちる
  const scrub = (Math.abs(car.yaw) + Math.abs(unmetYawRate) * 0.5) * VEHICLE.SCRUB;
  car.speed = Math.max(0, car.speed - scrub * car.speed * dt);

  // ── 路面外の判定と壁
  const currentSample = track.sampleAt(car.s);
  car.offTrack = Math.abs(car.lateral) > currentSample.halfWidth;
  const limit = currentSample.halfWidth + VEHICLE.RUNOFF;
  car.hitWall = false;
  if (Math.abs(car.lateral) > limit) {
    car.lateral = car.lateral > 0 ? limit : -limit;
    car.yaw *= 0.3;
    car.hitWall = true;
    car.speed = Math.min(car.speed, VEHICLE.WALL_SPEED);
  }

  car.lateralAccel = car.speed * yawRate;
  car.longitudinalAccel = (car.speed - previousSpeed) / dt;
}

/** s 地点の前後 4 m から求めた勾配（dy/ds） */
function gradientAt(track: Track, s: number): number {
  const ahead = track.sampleAt(s + 4);
  const behind = track.sampleAt(s - 4);
  return (ahead.position[1] - behind.position[1]) / 8;
}
