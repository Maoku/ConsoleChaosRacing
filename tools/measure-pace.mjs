#!/usr/bin/env tsx
/**
 * ペースと速度スケールの較正（バランス改修計画 §6）。
 *
 *   npm run measure:pace
 *
 * `BALANCE.SPEED_SCALE` も AI のペース較正も、**コース形状と車両定数から決まる実測値**で
 * あって設計者が選べる数ではない。手で書いた定数はコースを触った瞬間に嘘になるので、
 * 唯一の真実をこのツールに置く。`src/game/sim/` を直接 import するので、シムとツールで
 * 車両モデルが二重化する余地は無い。
 *
 * 出すもの:
 *
 *   1. 基準の走り — 自機スペック・ペース 1.0 の最高速度と理想ラップ
 *   2. `SPEED_SCALE` — **走行中の最高速度の比がちょうど 0.950 になる値**を二分探索で求める
 *      （要求の 0.95 は定数の値ではなく実測される比。§4.2）
 *   3. `REFERENCE_LAP_SECONDS` / `SECONDS_PER_PACE` — ペースを振り、ラップとの関係を最小二乗で
 *   4. `STANDING_START_SECONDS` — 立ち上がりの損（完走 − 飛び込み 3 周）
 *   5. 難易度ごとの目標タイム表と、それを達成するのに要るペース。
 *      **要るペースが `PACE.MIN`〜`MAX` を外れたら異常終了する**（到達不能な目標を弾く）
 *
 * 現在の定数とずれていたら警告する。速度定数・コース・AI のライン計算を変えたら必ず流す。
 */
import { stepRace, tickToSeconds } from '../src/game/sim/race.ts';
import { PACE } from '../src/game/sim/ai.ts';
import {
  BALANCE,
  DIFFICULTY,
  ENTRANT_COUNT,
  LAP_COUNT,
  createRaceState,
  targetRaceTicksFor,
} from '../src/game/sim/state.ts';

/** 実測比の目標。要求 R-1 そのもの */
const TARGET_SPEED_RATIO = 0.95;
/** 二分探索の許容誤差 */
const RATIO_TOLERANCE = 0.0002;
/** ペースを振る範囲。最小二乗の傾きはこの上側（0.85 以上）から取る */
const PACE_SWEEP = [0.8, 0.82, 0.85, 0.87, 0.9, 0.92, 0.95, 0.97, 1.0];
const SLOPE_FROM_PACE = 0.85;

/**
 * 干渉のない単独走行。
 *
 * 自機（個体差なし・理想ライン）を 1 台だけ残し、速度スケールとペースだけを差し替える。
 * こうすると測っているものが「その 2 つの効果」だけになる。
 *
 * @param fromGrid 真ならグリッド（ポール）位置から。偽ならスタートライン上から
 */
function soloRun(speedScale, pace, { laps = 3, fromGrid = false } = {}) {
  const state = createRaceState({ seed: 20260812, autoPilot: true });
  const car = state.cars[0];
  car.speedScale = speedScale;
  car.pace = pace;
  state.cars.length = 0;
  state.cars.push(car);
  state.standingOrder.length = 0;
  state.standingOrder.push(0);
  if (!fromGrid) {
    car.s = state.track.wrapS(0);
    car.lateral = 0;
  }

  const crossTicks = [];
  let goTick = -1;
  let maxSpeedInLap2 = 0;
  for (let step = 0; step < 60 * 900; step++) {
    const previousLap = car.lap;
    stepRace(state);
    if (goTick < 0 && state.phase === 'racing') goTick = state.tick;
    if (car.lap === 2 && car.speed > maxSpeedInLap2) maxSpeedInLap2 = car.speed;
    if (car.lap !== previousLap) crossTicks.push(state.tick);
    if (car.finished || crossTicks.length >= laps) break;
  }
  if (crossTicks.length < Math.min(laps, 2)) throw new Error('周回を走りきれなかった');

  const lapSeconds = crossTicks.map((tick, index) =>
    tickToSeconds(tick - (index === 0 ? goTick : crossTicks[index - 1])),
  );
  return {
    maxSpeed: maxSpeedInLap2,
    lapSeconds,
    raceSeconds: car.finished ? tickToSeconds(car.finishTick - goTick) : -1,
  };
}

/** 走行中の最高速度の比が `TARGET_SPEED_RATIO` になる速度スケールを探す */
function solveSpeedScale(baseMaxSpeed) {
  let low = 0.85;
  let high = 1.0;
  let scale = high;
  let ratio = 1;
  for (let iteration = 0; iteration < 24; iteration++) {
    scale = (low + high) / 2;
    ratio = soloRun(scale, 1).maxSpeed / baseMaxSpeed;
    if (Math.abs(ratio - TARGET_SPEED_RATIO) <= RATIO_TOLERANCE) break;
    if (ratio > TARGET_SPEED_RATIO) high = scale;
    else low = scale;
  }
  return { scale, ratio };
}

/** 最小二乗の傾き [秒 / ペース 1.0]。ペースが上がるほどラップは縮むので符号を反転して返す */
function leastSquaresSlope(samples) {
  const count = samples.length;
  const meanPace = samples.reduce((sum, s) => sum + s.pace, 0) / count;
  const meanLap = samples.reduce((sum, s) => sum + s.lapSeconds, 0) / count;
  let covariance = 0;
  let variance = 0;
  for (const sample of samples) {
    covariance += (sample.pace - meanPace) * (sample.lapSeconds - meanLap);
    variance += (sample.pace - meanPace) ** 2;
  }
  return -covariance / variance;
}

function fixed(value, digits = 3) {
  return value.toFixed(digits).padStart(digits + 5);
}

function report(label, measured, current, tolerance) {
  const ok = Math.abs(measured - current) <= tolerance;
  const mark = ok ? '一致' : `★ ずれている（許容 ±${tolerance}）`;
  console.log(`  ${label.padEnd(22)} 実測 ${fixed(measured, 4)}   定数 ${fixed(current, 4)}   ${mark}`);
  return ok;
}

// ── 1. 基準の走り
const base = soloRun(1, 1);
const idealLap = base.lapSeconds[1];
console.log('■ 基準（自機スペック・ペース 1.0・理想ライン・単独走行）');
console.log(`  走行中の最高速度   ${fixed(base.maxSpeed)} m/s`);
console.log(`  理想ラップ         ${fixed(idealLap)} s`);
console.log(`  1 周目             ${fixed(base.lapSeconds[0])} s（立ち上がりを含む）`);

// ── 2. 速度スケール
const solved = solveSpeedScale(base.maxSpeed);
console.log('');
console.log('■ SPEED_SCALE（走行中の最高速度の比が 0.950 になる値）');
console.log(`  実測比             ${solved.ratio.toFixed(4)}（目標 ${TARGET_SPEED_RATIO.toFixed(3)}）`);
const consistent = [report('SPEED_SCALE', solved.scale, BALANCE.SPEED_SCALE, 0.001)];

// ── 3. ペースとラップタイムの関係（敵車スペックで測る）
const samples = [];
for (const pace of PACE_SWEEP) {
  const run = soloRun(BALANCE.SPEED_SCALE, pace);
  samples.push({ pace, lapSeconds: run.lapSeconds[1], maxSpeed: run.maxSpeed });
}
console.log('');
console.log('■ ペースとラップ（SPEED_SCALE の車・単独走行）');
console.log('   pace     ラップ      最高速度');
for (const sample of samples) {
  console.log(`  ${sample.pace.toFixed(2)}   ${fixed(sample.lapSeconds)} s   ${fixed(sample.maxSpeed)} m/s`);
}
const referenceLap = samples.find((sample) => sample.pace === 1).lapSeconds;
const slope = leastSquaresSlope(samples.filter((sample) => sample.pace >= SLOPE_FROM_PACE));
// ── 4. 立ち上がりの損
// 目標タイムの式（§4.3）は `3 周ぶんのラップ + STANDING_START_SECONDS` なので、
// 損は**グリッドから GO して完走するまで**と**飛び込みラップ 3 周**の差で定義する。
// 単独・ペース 1.0・ポール位置での値であり、後方グリッドの余分な距離は
// ペース制御が残り距離から自動で織り込む（§4.4）
const gridRun = soloRun(BALANCE.SPEED_SCALE, 1, { laps: 99, fromGrid: true });
const startLoss = gridRun.raceSeconds - LAP_COUNT * referenceLap;
console.log('');
console.log('■ 立ち上がり（ポールからの単独走行・ペース 1.0）');
console.log(`  完走             ${fixed(gridRun.raceSeconds)} s ＝ AI の限界レース時間`);
console.log(`  飛び込み 3 周    ${fixed(LAP_COUNT * referenceLap)} s`);
console.log('');
console.log('■ ペース較正');
console.log(`  REFERENCE_LAP_SECONDS  ${fixed(referenceLap)} s`);
console.log(`  SECONDS_PER_PACE       ${fixed(slope)} s / ペース 1.0`);
console.log(`  STANDING_START_SECONDS ${fixed(startLoss)} s`);
consistent.push(report('STANDING_START_SECONDS', startLoss, BALANCE.STANDING_START_SECONDS, 0.05));
consistent.push(report('REFERENCE_LAP_SECONDS', referenceLap, PACE.REFERENCE_LAP_SECONDS, 0.05));
consistent.push(report('SECONDS_PER_PACE', slope, PACE.SECONDS_PER_PACE, 0.5));

// ── 5. 難易度ごとの目標と必要ペース
// 必要ペースは §2.5 の線形近似の逆写像。ペース制御（`updatePace`）はこれを
// 先読みに使うだけで、誤差は閉ループが吸う
const requiredPace = (lapSeconds) => 1 + (referenceLap - lapSeconds) / slope;
const reachable = [];
for (const difficulty of Object.keys(DIFFICULTY)) {
  console.log('');
  console.log(`■ 目標タイム（${difficulty}・ばらつき前）`);
  console.log('  entrant   目標ラップ    目標レース    必要ペース');
  for (let entrant = 1; entrant < ENTRANT_COUNT; entrant++) {
    const raceSeconds = tickToSeconds(targetRaceTicksFor(entrant, difficulty, 0));
    const lapSeconds = (raceSeconds - startLoss) / LAP_COUNT;
    const pace = requiredPace(lapSeconds);
    // ばらつき（最大 +2 秒）で目標が緩む側なので、厳しいのは常にばらつき 0 のとき
    if (pace < PACE.MIN || pace > PACE.MAX) {
      reachable.push(`${difficulty} の entrant ${entrant} は必要ペース ${pace.toFixed(3)}（範囲 ${PACE.MIN}〜${PACE.MAX}）`);
    }
    console.log(
      `     ${entrant}     ${fixed(lapSeconds)} s  ${fixed(raceSeconds, 2)} s     ${pace.toFixed(3)}`,
    );
  }
  const leader = tickToSeconds(targetRaceTicksFor(1, difficulty, 0));
  const last = tickToSeconds(targetRaceTicksFor(ENTRANT_COUNT - 1, difficulty, 0));
  console.log(`  トップ〜最下位の差 ${fixed(last - leader, 2)} s`);
  console.log(`  先頭の余裕（AI の限界 ${fixed(gridRun.raceSeconds, 2)} s との差） ${fixed(leader - gridRun.raceSeconds, 2)} s`);
}

console.log('');
for (const problem of reachable) console.error(`★ 到達できない目標: ${problem}`);

if (reachable.length > 0 || consistent.includes(false)) {
  console.error('★ 定数が実測とずれているか、達成できない目標がある。');
  process.exit(1);
}
console.log('定数は実測と一致し、どの難易度の目標もペースの範囲内で達成できる。');
