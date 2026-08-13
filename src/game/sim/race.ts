import { FIXED_DT_SECONDS } from '@console-chaos/engine';

import { driveAi } from './ai.js';
import { LAP_COUNT, type CarState, type RaceState } from './state.js';
import { stepVehicle, type VehicleControl } from './vehicle.js';

/**
 * レース進行（実装計画 §5.2）。
 *
 * 周回判定はワールド座標のライン交差ではなく**トラック空間の s の巻き戻り**で行う。
 * 決定論を保つため、時間はすべてティック数で持ち、秒への変換は表示のときだけ行う。
 */

const NEUTRAL: VehicleControl = { steer: 0, throttle: 0, brake: 0 };

export function tickToSeconds(ticks: number): number {
  return ticks * FIXED_DT_SECONDS;
}

/**
 * 「1:23.456」形式へ。未計測は「-:--.---」。
 *
 * 未計測の見出しを**計測済みと同じ 8 文字**にしてあるのは HUD の都合で、
 * 字数が違うと「TIME」と「BEST」の桁が縦に揃わなくなる（§3.5）。
 * 3 周のレースで 10 分を越えることは無いので、分は 1 桁で足りる。
 */
export function formatLapTime(ticks: number): string {
  if (ticks < 0) return '-:--.---';
  const totalMs = Math.round(tickToSeconds(ticks) * 1000);
  const minutes = Math.floor(totalMs / 60000);
  const seconds = Math.floor((totalMs % 60000) / 1000);
  const milliseconds = totalMs % 1000;
  return `${minutes}:${String(seconds).padStart(2, '0')}.${String(milliseconds).padStart(3, '0')}`;
}

/**
 * レースを 1 ティック進める。
 *
 * @param playerControl 自機の操作。`state.autoPilot` が真なら無視して AI が走らせる
 */
export function stepRace(state: RaceState, playerControl: VehicleControl = NEUTRAL): void {
  const track = state.track;
  const dt = FIXED_DT_SECONDS;

  if (state.phase === 'countdown') {
    state.countdown -= 1;
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.phase = 'racing';
    }
  }

  for (const car of state.cars) {
    const control =
      car.entrant === 0 && !state.autoPilot
        ? state.phase === 'countdown'
          ? NEUTRAL
          : playerControl
        : driveAi(state, car);

    const previousS = car.s;
    stepVehicle(car, control, track, dt);
    updateLap(state, car, previousS);
    car.progress = (car.lap - 1) * track.length + car.s;
  }

  updateStandings(state);

  if (state.phase === 'racing' && state.cars.every((car) => car.finished)) {
    state.phase = 'finished';
  }

  state.tick += 1;
}

/** s が巻き戻ったらスタートラインを越えたとみなす */
function updateLap(state: RaceState, car: CarState, previousS: number): void {
  const length = state.track.length;
  const crossed = previousS > length * 0.75 && car.s < length * 0.25;
  if (!crossed || car.finished) return;

  car.lap += 1;
  if (car.lapStartTick >= 0) {
    const lapTicks = state.tick - car.lapStartTick;
    car.lapTicks.push(lapTicks);
    if (car.bestLapTicks < 0 || lapTicks < car.bestLapTicks) car.bestLapTicks = lapTicks;
  }
  car.lapStartTick = state.tick;

  if (car.lap > LAP_COUNT) {
    car.finished = true;
    car.finishTick = state.tick;
  }
}

/**
 * 順位を決める。完走した車はゴール順、走行中の車は進行距離の降順。
 * 完走者は必ず未完走者より前に並ぶ。
 */
function updateStandings(state: RaceState): void {
  const order = state.standingOrder;
  for (let index = 0; index < state.cars.length; index++) order[index] = index;

  order.sort((left, right) => {
    const a = state.cars[left]!;
    const b = state.cars[right]!;
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished && b.finished) return a.finishTick - b.finishTick;
    return b.progress - a.progress;
  });

  for (let index = 0; index < order.length; index++) {
    state.cars[order[index]!]!.standing = index + 1;
  }
}

/** 表示用の周回数 1..LAP_COUNT。スタート前は 1 */
export function displayLap(car: CarState): number {
  return Math.min(LAP_COUNT, Math.max(1, car.lap));
}

/** 現在の周の経過ティック。未計測は -1 */
export function currentLapTicks(state: RaceState, car: CarState): number {
  if (car.lapStartTick < 0) return -1;
  if (car.finished) return car.lapTicks[car.lapTicks.length - 1] ?? -1;
  return state.tick - car.lapStartTick;
}
