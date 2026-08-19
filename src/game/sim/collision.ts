import type { CarState, RaceState } from './state.js';
import type { Track } from './track.js';
import { VEHICLE } from './vehicle.js';

/**
 * 車どうしの接触（実装計画 11-3 / R-3 / D-5・D-6）。
 *
 * **`stepRace()` が全車を進めたあとに 1 回だけ呼ぶ。** 1 台ずつの `stepVehicle` の
 * 中で解くと、更新順が結果を変えてしまう（先に進んだ車だけが押し離しを受ける）。
 *
 * 車体は**トラック空間の軸並行矩形**（前後 `CAR_LENGTH` × 左右 `CAR_WIDTH`）とみなす。
 * ヨー角は無視する — AI の操舵が生む姿勢角は最大でも 0.3 rad 程度で、矩形を回しても
 * 接触の判定はほとんど変わらないのに、決定性の検証だけが難しくなる（D-5）。
 *
 * 応答は**押し離しと速度の損だけ**である（D-6・§9-6）。跳ね返り係数は 0
 * （完全非弾性）で、ヨーには触れない — ヨーを乱すと AI の復帰能力とバランスの
 * 再調整が要る。「ゴム紐」も「弾き飛ばし」も入れない。
 */

export const CONTACT = {
  /** 追突で失う closing 速度の割合。0.5 が完全非弾性（等質量） */
  REAR_ABSORB: 0.5,
  /** 追突で「両者が」余分に失う割合。要求の「速度が落ちる」がこれ */
  REAR_LOSS: 0.35,
  /** 並走の擦りで失う速度 [m/s per (m/s の横方向の相対速度)] */
  SIDE_LOSS: 0.5,
  /** 押し離したあとに残す隙間 [m] */
  SEPARATION: 0.02,
} as const;

/** トラック接線方向の速度 [m/s]。前後の重なりを解くのに使う */
function advanceSpeed(car: CarState): number {
  return car.speed * Math.cos(car.yaw);
}

/** 横方向の速度 [m/s]。右が正 */
function lateralSpeed(car: CarState): number {
  return car.speed * Math.sin(car.yaw);
}

/**
 * 接触の記録。**強いほうを残す。** 同じティックで壁と車の両方に当たったとき、
 * 音として鳴らしたいのは強く当たったほうである。
 */
function recordContact(car: CarState, strength: number): void {
  if (car.hitKind !== 'none' && car.hitStrength >= strength) return;
  car.hitKind = 'car';
  car.hitStrength = strength;
}

/** 速度を減らす。**負にはしない**（後退しない車両モデル） */
function loseSpeed(car: CarState, loss: number): number {
  const applied = Math.min(car.speed, Math.max(0, loss));
  car.speed -= applied;
  return applied;
}

function resolvePair(track: Track, a: CarState, b: CarState): void {
  const ds = track.deltaS(a.s, b.s);
  const dl = a.lateral - b.lateral;
  const overlapS = VEHICLE.CAR_LENGTH - Math.abs(ds);
  const overlapL = VEHICLE.CAR_WIDTH - Math.abs(dl);
  if (overlapS <= 0 || overlapL <= 0) return;

  if (overlapS < overlapL) {
    // ── 前後の接触（追突）。重なりの浅いほうの軸で解く
    const rear = ds < 0 ? a : b;
    const front = ds < 0 ? b : a;
    const closing = advanceSpeed(rear) - advanceSpeed(front);
    let strength = 0;
    if (closing > 0) {
      // 後ろは closing の 85 % を失い、前は 15 % を受け取る。
      // 合計の運動量は必ず減る（0.85 − 0.15 = 0.7 ぶんが接触で失われる）
      strength = loseSpeed(rear, (CONTACT.REAR_ABSORB + CONTACT.REAR_LOSS) * closing);
      front.speed += (CONTACT.REAR_ABSORB - CONTACT.REAR_LOSS) * closing;
    }
    const push = (overlapS + CONTACT.SEPARATION) / 2;
    rear.s = track.wrapS(rear.s - push);
    front.s = track.wrapS(front.s + push);
    recordContact(a, strength);
    recordContact(b, strength);
  } else {
    // ── 左右の接触（擦り）。横へ離し、横方向の相対速度のぶんだけ速度を削る
    const push = (overlapL + CONTACT.SEPARATION) / 2;
    const right = dl > 0 ? a : b;
    const left = dl > 0 ? b : a;
    right.lateral += push;
    left.lateral -= push;

    const closing = Math.abs(lateralSpeed(a) - lateralSpeed(b));
    const strength = Math.max(
      loseSpeed(a, CONTACT.SIDE_LOSS * closing),
      loseSpeed(b, CONTACT.SIDE_LOSS * closing),
    );
    recordContact(a, strength);
    recordContact(b, strength);
  }
}

/**
 * 全ペアの重なりを解く。組は**添字の昇順**で回すので、結果は更新順に依らない。
 *
 * カウントダウン中（グリッドに並んでいる間）と完走した車は判定しない。
 * グリッドは 2 列 11 m 間隔で、車体の矩形どうしは触れていない。
 */
export function resolveCarContacts(state: RaceState): void {
  if (state.phase === 'countdown') return;
  const cars = state.cars;
  for (let left = 0; left < cars.length; left++) {
    const a = cars[left]!;
    if (a.finished) continue;
    for (let right = left + 1; right < cars.length; right++) {
      const b = cars[right]!;
      if (b.finished) continue;
      resolvePair(state.track, a, b);
    }
  }
}
