import {
  FIXED_DT_SECONDS,
  type GameContext,
  type GameInstance,
  type GameModule,
  type RenderFrame,
} from '@console-chaos/engine';

import { createEngineVoiceScheduler } from './audio/engine-sound.js';
import { arrangementFor } from './audio/score.js';
import { createRaceSfx } from './audio/sfx.js';
import { createRacingActionMap } from './input/bindings.js';
import { stepRace } from './sim/race.js';
import { createRaceState } from './sim/state.js';
import { VEHICLE, type VehicleControl } from './sim/vehicle.js';
import { buildGenerationView } from './view/index.js';
import { createDisplayLatch } from './view/shared/display-state.js';
import { PLAYER_ENTRANT, profileOf } from './view/shared/variants.js';

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

    // ── 音（実装計画 §4）。曲は 1 つで、世代が変わっても位相は保たれる。
    // 音源の差し替えは `GameHost` が `onSwitch` で自動的に行うので、
    // ゲーム側がやるのは**編曲の差し替えだけ**である
    const engineSound = createEngineVoiceScheduler();
    const sfx = createRaceSfx();
    context.audio.playScore(arrangementFor(context.generation.generation));
    const unsubscribeSwitch = context.generation.onSwitch((event) => {
      context.audio.useScore(arrangementFor(event.to));
    });

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

        // 音はシムの後。エンジン音は自機の状態から、効果音は立ち上がりから決まる。
        // どちらも `AudioContext` の時計で先読みするので、描画が落ちても乱れない
        const player = race.cars[PLAYER_ENTRANT]!;
        engineSound.update(context.audio, context.generation.profile, {
          speed: player.speed,
          maxSpeed: VEHICLE.MAX_SPEED,
          throttle: player.throttleInput,
          offTrack: player.offTrack,
        });
        sfx.update(context.audio, context.generation.profile, race);
      },

      buildRenderFrame(frame: RenderFrame) {
        frame.timeSeconds = seconds;

        // 切替中は 2 世代ぶんのコマンドを積む。シムは 1 つのまま。
        // ラッチも世代ごとに持つので、それぞれが自分の更新レートで止まって見える
        const generations = context.generation.renderGenerations();
        for (const generation of generations) {
          const profile = profileOf(generation);
          buildGenerationView(frame, {
            generation,
            profile,
            state: race,
            display: display.sample(generation, profile, race),
            seconds,
            renderedGenerations: generations.length,
          });
        }
      },

      dispose() {
        unsubscribeSwitch();
      },
    };
  },
};
