import type { CarState } from './state.js';
import type { Track } from './track.js';
import { WALL, wallMaterialAt } from './wall.js';

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
  /** 路外のグリップ倍率（草地の奥＝罰が最大のとき） */
  OFF_TRACK_GRIP: 0.45,
  /** 路外の追加抵抗 [m/s²]（同上） */
  OFF_TRACK_DRAG: 8,
  /** 罰が最大になる路外の深さ [m]。縁を割った直後の罰は浅い */
  OFF_TRACK_FULL_DEPTH: 3,
  /** 縁を割った瞬間の罰（0..1）。ここから深さに応じて 1 まで上がる */
  OFF_TRACK_MIN_SEVERITY: 0.3,
  /** 路面の側へ切った舵に返すグリップ倍率。路外でも「戻る意思」だけは通る */
  RECOVERY_GRIP: 0.85,
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
  /**
   * 車体の全長 [m]。衝突判定（`collision.ts`）・3D モデルの倍率・
   * 2D スプライトの世界寸法が共有する**唯一の値**（実装計画 D-7）。
   */
  CAR_LENGTH: 4.2,
  /**
   * 車体の全幅 [m]。第1・第2世代のスプライトを実測した値（`cellMeters` は
   * 正面のセルの車幅がこれになるように決めてある）。
   */
  CAR_WIDTH: 1.95,
  /** 路面外側の走行可能域（草地）[m] */
  RUNOFF: 9,
  /** 壁が殺す外向きヨーの残り */
  WALL_YAW_KILL: 0.25,
} as const;

/**
 * 壁の位置（中心線からの右向き距離）[m]。
 *
 * **シムと生成ツールがこの 1 つの式を読む**（実装計画 D-9）。以前はコースメッシュが
 * 縁石 1.2 m を足し忘れており、**描かれている壁がシムの壁より 1.2 m 外**にあった。
 */
export function wallLateral(halfWidth: number): number {
  return halfWidth + VEHICLE.RUNOFF;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

/**
 * その速度で出せる最大ヨー角速度 [rad/s]。
 *
 * 低速では舵が効かず（車が動いていないと向きは変わらない）、
 * 高速ではグリップが頭を押さえる。上限をグリップの `overshoot` 倍に留めるので、
 * 既定の `OVERSTEER_FACTOR` では「限界より 35% 速い」までしか無理は利かない。
 * 路外では `overshoot` に 1 を渡す（理由は下記 `steeringLimits`）。
 */
export function yawAuthority(
  speed: number,
  grip: number = VEHICLE.GRIP_ACCEL,
  overshoot: number = VEHICLE.OVERSTEER_FACTOR,
): number {
  const steering = (VEHICLE.MAX_YAW_RATE * speed) / (speed + VEHICLE.YAW_SPEED_REF);
  const gripLimited = (overshoot * grip) / Math.max(speed, 8);
  return Math.min(steering, gripLimited);
}

/**
 * 路外の罰の強さ 0..1。路面上は 0。
 *
 * 縁を割った瞬間に最大の罰を与えると、わずかにはみ出しただけでレースが終わる。
 * `OFF_TRACK_MIN_SEVERITY` から始めて `OFF_TRACK_FULL_DEPTH` で 1 に達する
 * 一次の傾斜にしてあるので、**浅いミスは浅く、深いミスは深く**罰が掛かる。
 */
export function offTrackSeverity(lateral: number, halfWidth: number): number {
  const depth = Math.abs(lateral) - halfWidth;
  if (depth <= 0) return 0;
  const ramp = clamp(depth / VEHICLE.OFF_TRACK_FULL_DEPTH, 0, 1);
  return VEHICLE.OFF_TRACK_MIN_SEVERITY + (1 - VEHICLE.OFF_TRACK_MIN_SEVERITY) * ramp;
}

/** 罰の強さに応じたグリップ [m/s²]。`severity` は `offTrackSeverity()` の値 */
export function gripAccel(severity: number): number {
  const scale = 1 - (1 - VEHICLE.OFF_TRACK_GRIP) * clamp(severity, 0, 1);
  return VEHICLE.GRIP_ACCEL * scale;
}

export interface SteeringLimits {
  /** この舵に効くグリップ [m/s²] */
  readonly grip: number;
  /** 出せる最大ヨー角速度 [rad/s] */
  readonly authority: number;
  /** グリップが許すヨー角速度 [rad/s]。これを超えた要求は横滑りになる */
  readonly gripYawRate: number;
}

/**
 * その舵に効く限界。**`stepVehicle` と AI が同じこの関数を通る**ので、
 * AI が「切ったつもりの舵」と実際の効きが食い違わない。
 *
 * 路外では 2 つの手心が入る（どちらも速度には触れない ＝ 減速の罰は残る）:
 *
 * 1. **戻り舵にだけグリップを返す**（`RECOVERY_GRIP`）。草地の 0.45 倍のままだと、
 *    舵を切っても向きが変わる前に流されて戻れない
 * 2. **無理な舵を許さない**（`overshoot` = 1）。要求がグリップ上限を超えると
 *    その差が横滑りになって**外へ**押し出す。戻ろうとするほど外へ出る、という
 *    逆向きの力が壁ぎわでは支配的だった
 *
 * @param steerDirection 舵の符号（右が正）。0 なら手心は掛からない
 */
export function steeringLimits(
  speed: number,
  lateral: number,
  halfWidth: number,
  steerDirection: number,
): SteeringLimits {
  const severity = offTrackSeverity(lateral, halfWidth);
  const towardTrack = lateral > 0 ? -1 : lateral < 0 ? 1 : 0;
  const recovering = severity > 0 && steerDirection * towardTrack > 0;
  const grip = recovering
    ? Math.max(gripAccel(severity), VEHICLE.GRIP_ACCEL * VEHICLE.RECOVERY_GRIP)
    : gripAccel(severity);
  const authority = yawAuthority(speed, grip, severity > 0 ? 1 : VEHICLE.OVERSTEER_FACTOR);
  return { grip, authority, gripYawRate: speed > 0.5 ? grip / speed : authority };
}

/**
 * その車の最高速度 [m/s]。`VEHICLE.MAX_SPEED` を直接読まず必ずここを通す。
 * 敵車は `speedScale` ぶん低い（バランス改修計画 §4.2）。
 */
export function topSpeedOf(car: CarState): number {
  return VEHICLE.MAX_SPEED * car.speedScale;
}

/**
 * その車の低速時加速度 [m/s²]。
 *
 * `MAX_SPEED` と揃えて同じ倍率を掛けるのが要点で、`dv/dt = kA(1 − v/kV)` は
 * `v → kv` で元の式に一致する。つまり**直線のどの瞬間でも速度がちょうど k 倍**の車になり、
 * 「終速の上限」ではなく「速度そのもの」で 0.95 が効く。
 */
export function accelOf(car: CarState): number {
  return VEHICLE.ACCEL * car.speedScale;
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
  const severity = offTrackSeverity(car.lateral, sample.halfWidth);

  const steer = clamp(control.steer, -1, 1);
  const throttle = clamp(control.throttle, 0, 1);
  const brake = clamp(control.brake, 0, 1);
  car.steerInput = steer;
  car.throttleInput = throttle;
  car.brakeInput = brake;

  // ── 速度: 目標速度への一次遅れ ＋ 抵抗
  const targetSpeed = topSpeedOf(car) * throttle;
  let acceleration: number;
  if (brake > 0) {
    acceleration = -VEHICLE.BRAKE_ACCEL * brake;
  } else if (targetSpeed > car.speed) {
    acceleration = accelOf(car) * (1 - car.speed / topSpeedOf(car));
  } else {
    acceleration = -VEHICLE.COAST_DRAG;
  }
  acceleration -= VEHICLE.OFF_TRACK_DRAG * severity;

  // バンクは坂と同じで、上り勾配ぶんの減速になる（第3・第4世代の起伏が走りに出る）
  const slope = -Math.sin(Math.atan(gradientAt(track, car.s))) * 9.81;
  acceleration += slope;

  car.speed = Math.max(0, car.speed + acceleration * dt);

  // ── 操舵: 要求ヨー角速度をグリップで頭打ちにする（路外の手心は `steeringLimits`）
  const limits = steeringLimits(car.speed, car.lateral, sample.halfWidth, Math.sign(steer));
  const demandedYawRate = steer * limits.authority;
  const yawRate = clamp(demandedYawRate, -limits.gripYawRate, limits.gripYawRate);
  const unmetYawRate = demandedYawRate - yawRate;

  // ── ヨー角（コース接線に対する相対角）
  const advance = car.speed * Math.cos(car.yaw);
  car.yaw += (yawRate + sample.curvature * advance - car.yaw * VEHICLE.YAW_DAMPING) * dt;
  car.yaw = clamp(car.yaw, -1.2, 1.2);

  // ── 位置。滑りは曲がりきれなかったぶんだけ外へ出る
  const slide = -unmetYawRate * car.speed * VEHICLE.SLIDE_TIME;
  const lateralVelocity = car.speed * Math.sin(car.yaw) + slide;
  car.s = track.wrapS(car.s + advance * dt);
  car.lateral += lateralVelocity * dt;

  // ── タイヤの引きずりで速度が落ちる
  const scrub = (Math.abs(car.yaw) + Math.abs(unmetYawRate) * 0.5) * VEHICLE.SCRUB;
  car.speed = Math.max(0, car.speed - scrub * car.speed * dt);

  // ── 路面外の判定と壁
  const currentSample = track.sampleAt(car.s);
  car.offTrack = Math.abs(car.lateral) > currentSample.halfWidth;
  const limit = wallLateral(currentSample.halfWidth);
  car.hitKind = 'none';
  car.hitStrength = 0;
  if (Math.abs(car.lateral) > limit) {
    // 壁は**外向きの運動だけ**を吸う。以前は当たるたびに位置を壁ちょうどへ留め、
    // ヨーを向きに関わらず 0.3 倍にし、速度を 14 m/s で頭打ちにしていた。
    // これだと内向きの舵でヨーが育たず、上の `slide` が外向きに勝って
    // **壁から永久に離れられない**（全開＋フル戻り舵で 30 秒たっても復帰しない）。
    const side = car.lateral > 0 ? 1 : -1;
    // 材質は「そこに何が立っているか」から決まる（`wall.ts`）。見えているタイヤ壁と
    // 当たり判定が構造的にずれない
    const material = wallMaterialAt(track, car.s, side);
    const wall = WALL[material];
    car.lateral = side * (limit - wall.bounce);
    // 外を向いたヨーは殺すが、内を向いたヨー ＝ 復帰の意思はそのまま残す
    if (car.yaw * side > 0) car.yaw *= VEHICLE.WALL_YAW_KILL;
    // 速度の罰は当たりの強さに比例させる。**掠りにも下限を置く**（D-10）—
    // 下限が無いと「壁を舐めながら走る」のがいちばん速いラインになってしまう
    const outward = Math.max(0, lateralVelocity * side);
    const loss = Math.min(car.speed, Math.max(outward * wall.bite, car.speed * wall.minimumLoss));
    car.speed -= loss;
    car.hitKind = material;
    car.hitStrength = loss;
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
