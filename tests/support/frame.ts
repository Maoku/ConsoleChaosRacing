import {
  HARDWARE_GENERATION_PROFILES,
  createRenderFrame,
  type GenerationId,
  type RenderFrame,
} from '@console-chaos/engine';

import { stepRace } from '../../src/game/sim/race.js';
import { createRaceState, type RaceState } from '../../src/game/sim/state.js';
import { buildGenerationView } from '../../src/game/view/index.js';
import { createDisplayLatch } from '../../src/game/view/shared/display-state.js';

/** 指定ティックまで進めたレース。テストどうしで使い回さないよう毎回作る */
export function raceAfter(ticks: number, seed = 20260812): RaceState {
  const state = createRaceState({ seed, autoPilot: true });
  for (let tick = 0; tick < ticks; tick++) stepRace(state);
  return state;
}

/**
 * 1 世代ぶんのフレームを組み立てる。
 * レンダラーを起こさずにコマンド列だけを検査できるので、契約テストはここを通る。
 */
export function buildFrame(
  generation: GenerationId,
  state: RaceState,
  seconds = 10,
): RenderFrame {
  const profile = HARDWARE_GENERATION_PROFILES[generation];
  const frame = createRenderFrame();
  const latch = createDisplayLatch();
  buildGenerationView(frame, {
    generation,
    profile,
    state,
    display: latch.sample(generation, profile, state),
    seconds,
  });
  return frame;
}
