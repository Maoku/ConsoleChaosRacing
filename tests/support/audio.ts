import type { AudioService, PlayRequest, Score, TransportClock } from '@console-chaos/engine';

/**
 * 手書きの `AudioService`（実装計画 §8「`engine-testkit` が無い」への対処）。
 *
 * 本物は `AudioContext` を要求するので、テストからは動かせない。ここでは
 * **時計を手で進められる**記録用の実装を置き、「いつ・何を予約したか」だけを見る。
 * 音そのものは世代ごとの音源が決めるので、ゲーム側の責任は予約の内容に尽きる。
 */

export interface FakeAudioService extends AudioService {
  /** 予約された単発音（`playOneShot`）。予約時刻の順ではなく呼ばれた順 */
  readonly oneShots: PlayRequest[];
  /** `useScore` で差し替えられた編曲の履歴 */
  readonly scores: Score[];
  /** 時計を進める [s] */
  advance(seconds: number): void;
  clear(): void;
}

const NOOP_CLOCK: TransportClock = {
  bpm: 152,
  beatsPerBar: 4,
  start: () => {},
  stop: () => {},
  resume: () => {},
  beatAt: () => 0,
  barAt: () => 0,
};

export function createFakeAudioService(): FakeAudioService {
  const oneShots: PlayRequest[] = [];
  const scores: Score[] = [];
  let time = 0;

  return {
    oneShots,
    scores,
    advance(seconds) {
      time += seconds;
    },
    clear() {
      oneShots.length = 0;
      scores.length = 0;
    },

    get currentTime() {
      return time;
    },
    clock: NOOP_CLOCK,
    currentSourceKey: null,
    barPosition: 0,
    unlock: async () => {},
    setGenerationVoiceLimit: () => {},
    setGenerationProfile: () => {},
    playScore: (score) => scores.push(score),
    useScore: (score) => scores.push(score),
    playOneShot: (request) => oneShots.push({ ...request }),
    playTone: () => {},
    setMuted: () => {},
    setVolume: () => {},
    update: () => {},
    dispose: () => {},
  };
}
