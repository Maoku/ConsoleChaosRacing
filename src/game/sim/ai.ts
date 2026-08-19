import { FIXED_DT_SECONDS } from '@console-chaos/engine';

import {
  BALANCE,
  COUNTDOWN_TICKS,
  LAP_COUNT,
  NO_TARGET,
  type CarState,
  type RaceState,
} from './state.js';
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
 * 個体差は `CarState` に焼き込まれた定数（`speedScale` / `lineBias` / `reactionTicks`）と、
 * 目標タイムから逆算されるペース倍率（`pace`）で表す。
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

/**
 * ペース制御の較正（バランス改修計画 §4.4）。
 *
 * 前 2 つは**実測値**なので `npm run measure:pace` の出力で置き換える。
 */
export const PACE = {
  /** ペース 1.0 で走ったときの 1 周 [s]（敵車スペック） */
  REFERENCE_LAP_SECONDS: 71.48,
  /** ペース 1 あたりのラップタイムの変化 [s] */
  SECONDS_PER_PACE: 50.01,
  /** ペースの下限。easy の最下位（必要ペース 0.836）を含められる値 */
  MIN: 0.8,
  /** 上限 1.0 が「ゴム紐なし」そのもの（決定 D-6）。事故で失った時間は取り返せない */
  MAX: 1.0,
  /**
   * 目標ペースへ寄せる速さ [1/s]。急な加減速に見えない程度に鈍くする。
   * 上下限の幅（0.2）× この値がペースの変化率の理論上の最大で、実測は 0.079 /s
   */
  RESPONSE: 0.5,
  /** 基準走行の表を刻む間隔 [m] */
  REFERENCE_STEP: 10,
} as const;

/**
 * 基準走行（ペース 1.0）で「1 周のどこまで来たか」を**距離ではなく時間で**測る表。
 *
 * これが無いと、残り距離を残り時間で割った要求ラップが**周回内の位置で振れる**。
 * ヘアピンは 19 m/s・最長の直線は 63 m/s なので、距離で測った進み具合は
 * 等速の予定に対して 1 周のうちに ±2 秒ぶんも前後する。AI はその見かけの遅れ／進みに
 * 反応して直線で緩めたりヘアピンで焦ったりし、最後に帳尻が合わなくなる。
 *
 * 表は AI 自身の速度計画（`plannedSpeedAt`）を 1 周ぶん積分して作る。使うのは
 * **形（どこが遅くどこが速いか）だけ**なので、合計が `REFERENCE_LAP_SECONDS` に
 * なるよう正規化してある。立ち上がりの加速は含まないが、それは形をわずかに
 * 歪めるだけで、絶対量はペース制御の閉ループが吸う。
 */
interface PaceReference {
  readonly step: number;
  /** s = 0 から各サンプル点までの基準所要時間 [s]。末尾は必ず 1 周ぶん */
  readonly cumulative: Float64Array;
}

const paceReferences = new WeakMap<Track, PaceReference>();

function paceReferenceFor(track: Track): PaceReference {
  const cached = paceReferences.get(track);
  if (cached) return cached;

  const count = Math.max(8, Math.round(track.length / PACE.REFERENCE_STEP));
  const step = track.length / count;
  const topSpeed = VEHICLE.MAX_SPEED * BALANCE.SPEED_SCALE;
  const cumulative = new Float64Array(count + 1);
  for (let index = 0; index < count; index++) {
    const s = index * step;
    const speed = Math.max(
      1,
      (plannedSpeedAt(track, s, topSpeed) + plannedSpeedAt(track, s + step, topSpeed)) / 2,
    );
    cumulative[index + 1] = cumulative[index]! + step / speed;
  }
  const scale = PACE.REFERENCE_LAP_SECONDS / cumulative[count]!;
  for (let index = 0; index <= count; index++) cumulative[index]! *= scale;

  const reference: PaceReference = { step, cumulative };
  paceReferences.set(track, reference);
  return reference;
}

/** s 地点までに基準走行が使う時間 [s]。0 <= 戻り値 <= REFERENCE_LAP_SECONDS */
function referenceTimeAt(reference: PaceReference, s: number): number {
  const position = s / reference.step;
  const index = Math.min(reference.cumulative.length - 2, Math.max(0, Math.floor(position)));
  const fraction = position - index;
  const low = reference.cumulative[index]!;
  const high = reference.cumulative[index + 1]!;
  return low + (high - low) * fraction;
}

/**
 * 目標タイムからペース倍率を毎ティック引き直す（要求 R-2 d）。
 *
 * **残りの道のりと残り時間から必要な平均ラップタイムを出し、それをペース倍率へ写す**閉ループ。
 * 残りの道のりは基準走行の表（`paceReferenceFor`）で**時間に換算して**測る。距離で測ると
 * 周回内の位置で要求が振れてしまう。
 * 開ループ（最初に 1 回だけペースを決める）だと、渋滞・接触・コースアウトで狂ったぶんが
 * そのまま最終タイムの誤差になり、要求の 15 秒差が崩れる。閉ループなら「遅れたら少し詰める・
 * 進みすぎたら少し緩める」が自然に出る。上限が 1.0 なのでゴム紐にはならない。
 *
 * `car.progress` はスタートラインからの走行距離（グリッド後方の車は負から始まる）なので、
 * **後方グリッドが余分に走る距離は自動的に目標へ織り込まれる**。
 */
function updatePace(state: RaceState, car: CarState): void {
  if (car.targetRaceTicks === NO_TARGET || car.finished || state.phase === 'countdown') return;

  const elapsedSeconds = Math.max(0, (state.tick - COUNTDOWN_TICKS) * FIXED_DT_SECONDS);
  const reference = paceReferenceFor(state.track);
  // 残りの道のり ＝ 今の周の残り ＋ 丸ごと残っている周
  const remainingReferenceSeconds =
    PACE.REFERENCE_LAP_SECONDS -
    referenceTimeAt(reference, car.s) +
    Math.max(0, LAP_COUNT - car.lap) * PACE.REFERENCE_LAP_SECONDS;
  if (remainingReferenceSeconds <= 0) return;
  const remainingSeconds = car.targetRaceTicks * FIXED_DT_SECONDS - elapsedSeconds;

  // 予定より遅れていれば要求ラップは 0 ＝ 全力（上限 1.0 で頭打ちになる）
  const requiredLap =
    remainingSeconds > 0
      ? (PACE.REFERENCE_LAP_SECONDS * remainingSeconds) / remainingReferenceSeconds
      : 0;
  const wanted = clamp(
    1 + (PACE.REFERENCE_LAP_SECONDS - requiredLap) / PACE.SECONDS_PER_PACE,
    PACE.MIN,
    PACE.MAX,
  );

  // GO の瞬間だけは寄せずに置く。立ち上がりでいきなり加減速して見えないように
  if (state.tick <= COUNTDOWN_TICKS) {
    car.pace = wanted;
    return;
  }
  car.pace += (wanted - car.pace) * PACE.RESPONSE * FIXED_DT_SECONDS;
}

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
function plannedSpeedAt(track: Track, s: number, topSpeed: number): number {
  // 路外に出ていても「本来のライン」を基準に計画する。路外のグリップで計画すると
  // 草地で止まってしまい、コースへ戻れなくなる（罰は物理側が与える）
  const grip = gripAccel(0) * AI.CORNER_SAFETY;
  let target = topSpeed;
  for (let distance = 0; distance <= AI.SCAN_MAX; distance += AI.SCAN_STEP) {
    const sample = track.sampleAt(s + distance);
    const cornerLimit = cornerSpeedLimit(sample.curvature, grip);
    const entrySpeed = Math.sqrt(
      cornerLimit * cornerLimit + 2 * VEHICLE.BRAKE_ACCEL * 0.85 * distance,
    );
    if (entrySpeed < target) target = entrySpeed;
  }
  return target;
}

function targetSpeedFor(track: Track, car: CarState): number {
  return plannedSpeedAt(track, car.s, topSpeedOf(car)) * car.pace;
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
  updatePace(state, car);

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
