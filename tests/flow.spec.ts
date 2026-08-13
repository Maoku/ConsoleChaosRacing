import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  createDeviceSnapshot,
  createGenerationController,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { createRacingActionMap, requestedGeneration } from '../src/game/input/bindings.js';
import {
  RESULT_DELAY_TICKS,
  acceptsDriving,
  createFlow,
  showsRaceHud,
  stepFlow,
  type FlowInput,
  type FlowState,
  type ScreenId,
} from '../src/game/flow/screens.js';
import { hashRaceState, LAP_COUNT } from '../src/game/sim/state.js';

/**
 * 画面の状態機械（実装計画 §5.2 / §6.2 `flow.spec.ts`）。
 *
 * ここで固定するのは 2 つ。
 *
 * 1. `title → countdown → racing → finished → result → title / countdown` を正しく巡ること
 * 2. **タイトルのアトラクトデモがレースの内容に影響しないこと** —
 *    デモを何秒眺めていても、始まるレースは同じシードの同じレースになる
 */

const IDLE: FlowInput = {
  control: { steer: 0, throttle: 0, brake: 0 },
  confirm: false,
  back: false,
  pause: false,
};

const FULL_THROTTLE = { steer: 0, throttle: 1, brake: 0 };

function press(key: 'confirm' | 'back' | 'pause'): FlowInput {
  return { ...IDLE, [key]: true };
}

/**
 * レースを始めて、**自機も AI に代走させる**。
 *
 * 3 周を完走させたいだけのテストで人力の入力列を書くのは本題ではない。
 * `autoPilot` を立てると `stepRace` が自機にも `driveAi` を使うので、
 * 状態機械の側から見た振る舞い（ゴール → finished → result）はそのまま検査できる。
 */
function startRaceOnAutoPilot(flow: FlowState): void {
  stepFlow(flow, press('confirm'));
  flow.race.autoPilot = true;
}

/** 画面が変わるまで（または上限まで）進める。戻り値は掛かった tick */
function runUntil(flow: FlowState, screen: ScreenId, limit: number, input = IDLE): number {
  for (let tick = 0; tick < limit; tick++) {
    stepFlow(flow, input);
    if (flow.screen === screen) return tick + 1;
  }
  throw new Error(`${limit} tick 以内に ${screen} へ到達しなかった（いま ${flow.screen}）`);
}

describe('画面の状態機械', () => {
  it('起動直後はタイトルで、アトラクトデモが走っている', () => {
    const flow = createFlow();
    expect(flow.screen).toBe('title');
    expect(flow.race.autoPilot).toBe(true);

    const before = flow.race.cars[0]!.progress;
    for (let tick = 0; tick < 600; tick++) stepFlow(flow, IDLE);
    expect(flow.screen).toBe('title');
    // 自機も AI が走らせている（アトラクト）
    expect(flow.race.cars[0]!.progress).not.toBe(before);
  });

  it('決定で countdown へ進み、カウントダウンが明けると racing になる', () => {
    const flow = createFlow();
    const transition = stepFlow(flow, press('confirm'));
    expect(transition).toMatchObject({ from: 'title', to: 'countdown', raceRestarted: true });
    expect(flow.race.autoPilot).toBe(false);
    expect(flow.screenTicks).toBe(0);

    runUntil(flow, 'racing', 400);
    expect(flow.race.phase).toBe('racing');
  });

  it('自機がゴールすると finished、少し置いて result になる', () => {
    const flow = createFlow();
    startRaceOnAutoPilot(flow);
    // 3 周 ≒ 9,000 m。60Hz × 300 秒あれば足りる
    runUntil(flow, 'finished', 60 * 300);
    expect(flow.race.cars[0]!.finished).toBe(true);
    expect(flow.race.cars[0]!.lap).toBe(LAP_COUNT + 1);

    const ticks = runUntil(flow, 'result', RESULT_DELAY_TICKS + 5);
    expect(ticks).toBe(RESULT_DELAY_TICKS);
  });

  it('リザルトから決定でリトライ、戻るでタイトルへ', () => {
    const flow = createFlow();
    startRaceOnAutoPilot(flow);
    runUntil(flow, 'finished', 60 * 300);
    runUntil(flow, 'result', RESULT_DELAY_TICKS + 5);

    const retry = stepFlow(flow, press('confirm'));
    expect(retry).toMatchObject({ from: 'result', to: 'countdown', raceRestarted: true });
    expect(flow.race.tick).toBe(0);

    runUntil(flow, 'racing', 400);
    const home = stepFlow(flow, press('back'));
    expect(home).toMatchObject({ to: 'title', raceRestarted: true });
    expect(flow.race.autoPilot).toBe(true);
  });

  it('走行中はどこからでも戻るでタイトルへ帰れる', () => {
    for (const screen of ['countdown', 'racing'] as const) {
      const flow = createFlow();
      stepFlow(flow, press('confirm'));
      if (screen === 'racing') runUntil(flow, 'racing', 400);
      expect(flow.screen).toBe(screen);
      expect(stepFlow(flow, press('back'))).toMatchObject({ to: 'title' });
    }
  });

  describe('ポーズ', () => {
    it('シムが止まり、決定で再開する', () => {
      const flow = createFlow();
      stepFlow(flow, press('confirm'));
      runUntil(flow, 'racing', 400);

      stepFlow(flow, press('pause'));
      expect(flow.paused).toBe(true);
      const frozen = hashRaceState(flow.race);
      for (let tick = 0; tick < 120; tick++) stepFlow(flow, { ...IDLE, control: FULL_THROTTLE });
      expect(hashRaceState(flow.race)).toBe(frozen);
      // 画面の時計は止まらない（「PAUSED」の点滅が固まらないように）
      expect(flow.screenTicks).toBeGreaterThan(120);

      stepFlow(flow, press('confirm'));
      expect(flow.paused).toBe(false);
      stepFlow(flow, { ...IDLE, control: FULL_THROTTLE });
      expect(hashRaceState(flow.race)).not.toBe(frozen);
    });

    it('ポーズ中でもタイトルへ戻れる', () => {
      const flow = createFlow();
      stepFlow(flow, press('confirm'));
      runUntil(flow, 'racing', 400);
      stepFlow(flow, press('pause'));
      expect(stepFlow(flow, press('back'))).toMatchObject({ to: 'title' });
      expect(flow.paused).toBe(false);
    });
  });

  describe('アトラクトデモの分離', () => {
    it('デモを眺めた長さがレースの内容を変えない', () => {
      // 「決定へ進む際にシムをシードから作り直す」（§5.2）ことの機械的な担保。
      // 眺めた時間が混ざると、同じ操作をしても毎回違うレースになってしまう
      const hashes = [0, 137, 999, 5000].map((idleTicks) => {
        const flow = createFlow();
        for (let tick = 0; tick < idleTicks; tick++) stepFlow(flow, IDLE);
        stepFlow(flow, press('confirm'));
        for (let tick = 0; tick < 600; tick++) {
          stepFlow(flow, { ...IDLE, control: FULL_THROTTLE });
        }
        return hashRaceState(flow.race);
      });
      expect(new Set(hashes).size).toBe(1);
    });

    it('タイトルへ戻ってから始め直しても同じレースになる', () => {
      const flow = createFlow();
      stepFlow(flow, press('confirm'));
      for (let tick = 0; tick < 600; tick++) stepFlow(flow, { ...IDLE, control: FULL_THROTTLE });
      const first = hashRaceState(flow.race);

      stepFlow(flow, press('back'));
      for (let tick = 0; tick < 321; tick++) stepFlow(flow, IDLE);
      stepFlow(flow, press('confirm'));
      for (let tick = 0; tick < 600; tick++) stepFlow(flow, { ...IDLE, control: FULL_THROTTLE });
      expect(hashRaceState(flow.race)).toBe(first);
    });

    it('リトライは前のレースとは別のシードになる', () => {
      // 同じレースの繰り返しにならないよう、リトライは何度目かでシードを変える。
      // それでも「何 tick 眺めたか」は混ざらないので決定論は保たれる
      const flow = createFlow();
      startRaceOnAutoPilot(flow);
      const first = flow.race.seed;
      runUntil(flow, 'finished', 60 * 300);
      runUntil(flow, 'result', RESULT_DELAY_TICKS + 5);
      stepFlow(flow, press('confirm'));
      expect(flow.race.seed).not.toBe(first);
    });
  });

  /**
   * 世代の直接指定（実装計画 8-7）。
   *
   * `1`〜`4` キーが HUD の `CH n : NTH GEN`（8-8）とそのまま対応することが要点で、
   * **表示と操作で同じ番号が使われている**ことがチャンネルの見立てを成立させる。
   */
  describe('世代の直接指定', () => {
    /** キーを離した状態 → 押した状態、と 2 回サンプルして `pressed` を作る */
    function pressKey(key: string) {
      const actions = createRacingActionMap();
      const profile = HARDWARE_GENERATION_PROFILES.FC;
      actions.sample(createDeviceSnapshot([]), profile, 16);
      return actions.sample(createDeviceSnapshot([key]), profile, 16);
    }

    it('4 つのキーがそれぞれ対応する世代を要求する', () => {
      GENERATION_IDS.forEach((generation, index) => {
        for (const key of [`Digit${index + 1}`, `Numpad${index + 1}`]) {
          expect(requestedGeneration(pressKey(key)), key).toBe(generation);
        }
      });
    });

    it('押していなければ何も要求しない', () => {
      expect(requestedGeneration(pressKey('KeyZ'))).toBeNull();
    });

    it('表示中の世代を要求しても切替は起きない', () => {
      const controller = createGenerationController('PS1');
      expect(controller.request(requestedGeneration(pressKey('Digit3'))!)).toBe(false);
      expect(controller.transition.active).toBe(false);
      // 別のチャンネルなら切り替わる。順送り（Q / E）と同じ経路を通る
      expect(controller.request(requestedGeneration(pressKey('Digit1'))!)).toBe(true);
      expect(controller.transition.to).toBe('FC');
    });
  });

  describe('画面ごとの扱い', () => {
    it('操作と HUD を出すのは走行中の 3 画面だけ', () => {
      const driving: ScreenId[] = ['countdown', 'racing', 'finished'];
      for (const screen of ['title', 'countdown', 'racing', 'finished', 'result'] as const) {
        expect(acceptsDriving(screen), screen).toBe(driving.includes(screen));
        expect(showsRaceHud(screen), screen).toBe(driving.includes(screen));
      }
    });
  });
});
