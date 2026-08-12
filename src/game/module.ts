import {
  FIXED_DT_SECONDS,
  type GameContext,
  type GameInstance,
  type GameModule,
  type RenderFrame,
} from '@console-chaos/engine';

import { createRacingActionMap } from './input/bindings.js';
import { stepRace } from './sim/race.js';
import { createRaceState } from './sim/state.js';
import type { VehicleControl } from './sim/vehicle.js';
import { buildGenerationView } from './view/index.js';
import { createDisplayLatch } from './view/shared/display-state.js';
import { profileOf } from './view/shared/variants.js';

/**
 * ゲームモジュール（実装計画 §2.4）。
 *
 * ここがやるのは 3 つだけ — 入力を取り、シムを 1 ティック進め、
 * 描画する世代のぶんだけビューを呼ぶ。世代ごとの表現は `view/index.ts` の
 * 割り当てテーブルの向こう側にある。
 */
export const racingModule: GameModule = {
  id: 'console-chaos-racing',
  async create(context: GameContext): Promise<GameInstance> {
    const actions = createRacingActionMap();
    // タイトル画面が入るまでは、起動直後から AI 8 台のレースを回す
    const race = createRaceState({ autoPilot: true });
    const display = createDisplayLatch();
    let seconds = 0;

    return {
      fixedUpdate() {
        seconds += FIXED_DT_SECONDS;

        const input = actions.sample(
          context.input.snapshot,
          context.generation.profile,
          FIXED_DT_SECONDS * 1000,
        );
        if (input.genNext.pressed) context.generation.cycle(1);
        if (input.genPrev.pressed) context.generation.cycle(-1);

        // 自機の操作。何か踏まれた時点でアトラクトデモを抜ける
        const control: VehicleControl = {
          steer: input.steer,
          throttle: input.throttle.value,
          brake: input.brake.value,
        };
        if (race.autoPilot && (input.throttle.pressed || input.brake.pressed)) {
          race.autoPilot = false;
        }

        stepRace(race, control);
      },

      buildRenderFrame(frame: RenderFrame) {
        frame.timeSeconds = seconds;

        // 切替中は 2 世代ぶんのコマンドを積む。シムは 1 つのまま。
        // ラッチも世代ごとに持つので、それぞれが自分の更新レートで止まって見える
        for (const generation of context.generation.renderGenerations()) {
          const profile = profileOf(generation);
          buildGenerationView(frame, {
            generation,
            profile,
            state: race,
            display: display.sample(generation, profile, race, seconds),
            seconds,
          });
        }
      },

      dispose() {},
    };
  },
};
