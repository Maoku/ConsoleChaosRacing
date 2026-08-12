import { createRng } from '@console-chaos/engine';

import type { VehicleControl } from '../../src/game/sim/vehicle.js';

/**
 * 決定論テスト用の、再現可能な操作列。
 *
 * `context.rng` と同じ決定論乱数から作るので、同じシードなら常に同じ操作になる。
 * 実プレイに似た「アクセルを踏み、たまにブレーキ、左右に振る」列を返す。
 */
export function createScriptedInput(seed: number): (tick: number) => VehicleControl {
  const rng = createRng(seed);
  const steerNoise: number[] = [];
  const brakeAt = new Set<number>();
  for (let index = 0; index < 512; index++) steerNoise.push(rng.next() * 2 - 1);
  for (let index = 0; index < 64; index++) brakeAt.add(rng.int(10000));

  return (tick: number): VehicleControl => {
    const steer = steerNoise[tick % steerNoise.length]! * 0.6;
    const braking = brakeAt.has(tick % 10000);
    return { steer, throttle: braking ? 0 : 1, brake: braking ? 1 : 0 };
  };
}
