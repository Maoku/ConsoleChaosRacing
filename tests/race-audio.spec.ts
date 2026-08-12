import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  type HardwareGenerationProfile,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import {
  ENGINE_LOOKAHEAD_SECONDS,
  GEAR_COUNT,
  createEngineVoiceScheduler,
  gearFor,
  intervalSecondsFor,
  rpmFor,
} from '../src/game/audio/engine-sound.js';
import { createRaceSfx } from '../src/game/audio/sfx.js';
import { stepRace } from '../src/game/sim/race.js';
import { COUNTDOWN_TICKS, createRaceState } from '../src/game/sim/state.js';
import { VEHICLE } from '../src/game/sim/vehicle.js';
import { createFakeAudioService } from './support/audio.js';

/**
 * エンジン音と効果音（実装計画 §4.3 / §4.4）。
 *
 * どちらも**継続音の無い API の上で継続音を作る**仕組みなので、壊れ方が
 * 「無音」か「予約が詰まって暴走」の両極になる。予約の内容と量を直接検査する。
 */

const FIXED_DT = 1 / 60;

function drive(
  profile: HardwareGenerationProfile,
  speedRatios: readonly number[],
  ticks = 60,
) {
  const audio = createFakeAudioService();
  const scheduler = createEngineVoiceScheduler();
  for (const ratio of speedRatios) {
    for (let tick = 0; tick < ticks; tick++) {
      scheduler.update(audio, profile, {
        speed: VEHICLE.MAX_SPEED * ratio,
        maxSpeed: VEHICLE.MAX_SPEED,
        throttle: 1,
        offTrack: false,
      });
      audio.advance(FIXED_DT);
    }
  }
  return { audio, scheduler };
}

describe('エンジン音', () => {
  describe('擬似ギア', () => {
    it('速度域を 4 段に割る', () => {
      expect(gearFor(0)).toBe(0);
      expect(gearFor(0.49)).toBe(1);
      expect(gearFor(1)).toBe(GEAR_COUNT - 1);
    });

    it('段の中で回転が上がり、シフトアップで落ちる', () => {
      // この鋸歯がギアの音。速度をそのまま周波数へ写すと「ただ高くなるだけ」になる
      const justBelow = rpmFor(0.2499);
      const justAbove = rpmFor(0.2501);
      expect(justBelow).toBeGreaterThan(0.9);
      expect(justAbove).toBeLessThan(0.3);
      expect(justAbove).toBeLessThan(justBelow);
    });

    it('停車中でも回っている', () => {
      expect(rpmFor(0)).toBeGreaterThan(0);
    });
  });

  describe('予約', () => {
    it('先読み範囲を隙間なく埋める', () => {
      const { audio } = drive(HARDWARE_GENERATION_PROFILES.PS2, [0.5], 30);
      const times = audio.oneShots.map((request) => request.when).sort((a, b) => a - b);
      expect(times.length).toBeGreaterThan(3);
      for (let index = 1; index < times.length; index++) {
        const gap = times[index]! - times[index - 1]!;
        // 音の長さは間隔の 1.6 倍なので、間隔ぶん空いていても音は途切れない
        expect(gap).toBeGreaterThan(0);
        expect(gap).toBeLessThanOrEqual(0.2);
      }
    });

    it('予約が現在時刻より先で、先読みの範囲に収まる', () => {
      const audio = createFakeAudioService();
      const scheduler = createEngineVoiceScheduler();
      for (let tick = 0; tick < 120; tick++) {
        audio.clear();
        scheduler.update(audio, HARDWARE_GENERATION_PROFILES.PS1, {
          speed: 40,
          maxSpeed: VEHICLE.MAX_SPEED,
          throttle: 0.8,
          offTrack: false,
        });
        for (const request of audio.oneShots) {
          expect(request.when).toBeGreaterThanOrEqual(audio.currentTime - 1e-9);
          expect(request.when).toBeLessThan(audio.currentTime + ENGINE_LOOKAHEAD_SECONDS);
        }
        audio.advance(FIXED_DT);
      }
    });

    it('時計が飛んでも予約が溜まらない', () => {
      // タブが裏に回ると `currentTime` が大きく進む。追いつこうとして
      // 何千発も予約すると、復帰した瞬間に全部が鳴る
      const audio = createFakeAudioService();
      const scheduler = createEngineVoiceScheduler();
      const input = { speed: 30, maxSpeed: VEHICLE.MAX_SPEED, throttle: 1, offTrack: false };
      scheduler.update(audio, HARDWARE_GENERATION_PROFILES.FC, input);
      audio.advance(30);
      audio.clear();
      scheduler.update(audio, HARDWARE_GENERATION_PROFILES.FC, input);
      expect(audio.oneShots.length).toBeLessThanOrEqual(24);
      for (const request of audio.oneShots) {
        expect(request.when).toBeGreaterThanOrEqual(audio.currentTime - 1e-9);
      }
    });

    it('回転が上がるほど間隔が詰まる', () => {
      const profile = HARDWARE_GENERATION_PROFILES.PS2;
      expect(intervalSecondsFor(1, profile)).toBeLessThan(intervalSecondsFor(0, profile));
    });

    it('声数の少ない世代ほど間隔を空ける（BGM を食わない）', () => {
      const intervals = GENERATION_IDS.map((generation) =>
        intervalSecondsFor(0.5, HARDWARE_GENERATION_PROFILES[generation]),
      );
      // 世代 ID ではなく profile.audio.channels から決まる
      expect(intervals[0]).toBeGreaterThan(intervals[1]!);
      expect(intervals[1]).toBeGreaterThan(intervals[2]!);
      expect(intervals[2]).toBeCloseTo(intervals[3]!, 9);
    });

    it('効果音の役割で鳴らす（BGM より先に声を譲る）', () => {
      const { audio } = drive(HARDWARE_GENERATION_PROFILES.FC, [0.4], 10);
      expect(audio.oneShots.length).toBeGreaterThan(0);
      for (const request of audio.oneShots) expect(request.role).toBe('fx');
    });

    it('速度が上がると音が高くなる', () => {
      const slow = drive(HARDWARE_GENERATION_PROFILES.PS2, [0.05], 10);
      const fast = drive(HARDWARE_GENERATION_PROFILES.PS2, [0.2], 10);
      expect(fast.audio.oneShots[0]!.frequency).toBeGreaterThan(
        slow.audio.oneShots[0]!.frequency,
      );
    });

    it('定位を持たない世代には pan を渡さない', () => {
      const audio = createFakeAudioService();
      const scheduler = createEngineVoiceScheduler();
      const input = {
        speed: 30,
        maxSpeed: VEHICLE.MAX_SPEED,
        throttle: 1,
        offTrack: false,
      };
      scheduler.update(audio, HARDWARE_GENERATION_PROFILES.FC, input);
      for (const request of audio.oneShots) expect(request.pan).toBeUndefined();
    });
  });
});

describe('効果音', () => {
  function fresh() {
    const audio = createFakeAudioService();
    const sfx = createRaceSfx();
    const race = createRaceState({ seed: 7, autoPilot: true });
    return { audio, sfx, race };
  }

  /** カウントダウンを抜けて走行状態にする */
  function toRacing(race: ReturnType<typeof createRaceState>) {
    for (let tick = 0; tick <= COUNTDOWN_TICKS + 2; tick++) stepRace(race);
  }

  it('カウントダウンで 1 秒ごとに 1 発ずつ鳴る', () => {
    const { audio, sfx, race } = fresh();
    for (let tick = 0; tick <= COUNTDOWN_TICKS + 2; tick++) {
      stepRace(race);
      sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
      audio.advance(FIXED_DT);
    }
    const signals = audio.oneShots.filter((request) => request.role === 'lead');
    // 3・2・1 と GO。カウントダウンの入り口を含めても 5 発を超えない
    expect(signals.length).toBeGreaterThanOrEqual(4);
    expect(signals.length).toBeLessThanOrEqual(5);
    // GO が最も高く、最も強い
    expect(signals[signals.length - 1]!.velocity).toBe(1);
  });

  it('ブレーキは踏んだ瞬間に 1 発、保持中は一定間隔で鳴る', () => {
    const { audio, sfx, race } = fresh();
    toRacing(race);
    audio.clear();

    const player = race.cars[0]!;
    player.speed = 40;
    player.brakeInput = 1;
    // 1 ティックめ ＝ 立ち上がり
    sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    const first = audio.oneShots.length;
    expect(first).toBeGreaterThanOrEqual(1);

    // 同じティックの中では増えない（立ち上がりは 1 回だけ）
    for (let tick = 0; tick < 5; tick++) {
      audio.advance(FIXED_DT);
      player.brakeInput = 1;
      sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    }
    const held = audio.oneShots.length;
    expect(held).toBeGreaterThan(first);

    // 離すと止まる
    audio.clear();
    player.brakeInput = 0;
    for (let tick = 0; tick < 20; tick++) {
      audio.advance(FIXED_DT);
      sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    }
    expect(audio.oneShots).toHaveLength(0);
  });

  it('路外では速度に応じた音が鳴り、停まれば止まる', () => {
    const { audio, sfx, race } = fresh();
    toRacing(race);
    const player = race.cars[0]!;

    player.offTrack = true;
    player.speed = 30;
    for (let tick = 0; tick < 30; tick++) {
      sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS1, race);
      audio.advance(FIXED_DT);
    }
    const moving = audio.oneShots.filter((request) => request.role === 'perc');
    expect(moving.length).toBeGreaterThan(0);

    audio.clear();
    player.speed = 0;
    for (let tick = 0; tick < 30; tick++) {
      sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS1, race);
      audio.advance(FIXED_DT);
    }
    expect(audio.oneShots).toHaveLength(0);
  });

  it('接触は 1 ティックのフラグで 1 発だけ鳴る', () => {
    const { audio, sfx, race } = fresh();
    toRacing(race);
    audio.clear();
    const player = race.cars[0]!;
    player.speed = 50;
    player.hitWall = true;
    sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    expect(audio.oneShots).toHaveLength(1);

    audio.clear();
    player.hitWall = false;
    audio.advance(FIXED_DT);
    sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    expect(audio.oneShots).toHaveLength(0);
  });

  it('周回を跨ぐと 1 回だけ鳴る', () => {
    const { audio, sfx, race } = fresh();
    toRacing(race);
    audio.clear();
    const player = race.cars[0]!;

    player.lap = 1;
    sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    expect(audio.oneShots.filter((request) => request.role === 'lead')).toHaveLength(1);

    audio.clear();
    audio.advance(FIXED_DT);
    sfx.update(audio, HARDWARE_GENERATION_PROFILES.PS2, race);
    expect(audio.oneShots.filter((request) => request.role === 'lead')).toHaveLength(0);
  });

  it('定位は持つ世代にだけ渡る', () => {
    for (const generation of GENERATION_IDS) {
      const profile = HARDWARE_GENERATION_PROFILES[generation];
      const { audio, sfx, race } = fresh();
      toRacing(race);
      audio.clear();
      const player = race.cars[0]!;
      player.speed = 50;
      player.hitWall = true;
      sfx.update(audio, profile, race);
      const request = audio.oneShots[0]!;
      if (profile.audio.positional) {
        expect(request.pan, `${generation}`).toBeTypeOf('number');
      } else {
        expect(request.pan, `${generation}`).toBeUndefined();
      }
    }
  });
});
