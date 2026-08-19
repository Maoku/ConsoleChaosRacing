import type { AudioService, HardwareGenerationProfile } from '@console-chaos/engine';

import { COUNTDOWN_TICKS, type CarState, type RaceState } from '../sim/state.js';
import { VEHICLE } from '../sim/vehicle.js';

/**
 * 効果音（実装計画 §4.4）。
 *
 * すべて `playOneShot` を通るので、**世代が変われば音色も自動的に変わる**。
 * このファイルには「いつ鳴らすか」しか書かない — 何の音が出るかは
 * `profile.audio.synth` が選んだ音源が決める。
 *
 * 立ち上がり（前のティックとの差）で鳴らす音と、押している間ずっと一定間隔で
 * 鳴らし続ける音がある。後者はエンジン音と同じく `AudioContext` の時計で先読みする。
 */

/** ブレーキを踏んだ瞬間の一撃 */
const BRAKE_HIT = { frequency: 1180, duration: 0.16, velocity: 0.5 } as const;
/** 踏み続けている間の擦過音 */
const BRAKE_HOLD = { frequency: 2100, duration: 0.07, velocity: 0.22, intervalMs: 120 } as const;
/** 路面外を走っている間の低いノイズ。速度に連れて強くなる */
const OFF_TRACK = { frequency: 120, duration: 0.1, intervalMs: 90 } as const;
/**
 * 接触音（実装計画 11-4 / R-4）。**当たった相手ごとに音を変える。**
 *
 * コンクリートは硬く高く、タイヤは低く短く（沈んで止まる）、車は金属質の軽い当たり。
 * どれも `playOneShot` を通るので、**世代が変われば音色も変わる**。
 *
 * 強さは自車速度ではなく**実際に失った速度**（`hitStrength`）から決める。
 * 掠りは小さく、激突は大きく鳴る — 速度で決めると、高速で壁を舐めただけでも
 * 激突と同じ音になってしまう。
 */
const IMPACT = {
  concrete: { role: 'perc', frequency: 78, duration: 0.3 },
  tyre: { role: 'perc', frequency: 55, duration: 0.22 },
  car: { role: 'fx', frequency: 220, duration: 0.12 },
} as const;

/** この速度 [m/s] を失う当たりで音量が最大になる */
const IMPACT_FULL_LOSS = 20;
/** 周回通過。`lead` の単音なので BGM と同じ音色で鳴る */
const LAP = { frequency: 880, duration: 0.22, velocity: 0.6 } as const;
/** スタートシグナル。3・2・1 と GO で高さを変える */
const SIGNAL = { low: 587, high: 1175, duration: 0.18, velocity: 0.7 } as const;

/** ブレーキを踏んだと見なす入力量 */
const BRAKE_THRESHOLD = 0.15;

export interface RaceSfx {
  /** 毎 `fixedUpdate` で呼ぶ。自機の状態と `RaceState` から鳴らす音を決める */
  update(audio: AudioService, profile: HardwareGenerationProfile, state: RaceState): void;
  reset(): void;
}

/** 一定間隔で鳴らし続ける音の予約位置を持つ */
interface Repeater {
  next: number;
}

function repeat(
  audio: AudioService,
  repeater: Repeater,
  intervalMs: number,
  emit: (when: number) => void,
): void {
  const now = audio.currentTime;
  if (repeater.next < now) repeater.next = now;
  const interval = intervalMs / 1000;
  // 先読みは 1 発ぶんだけ。押し続けている間しか鳴らないので、
  // 離した後に予約が残らないよう短く採る
  if (repeater.next < now + interval) {
    emit(repeater.next);
    repeater.next += interval;
  }
}

export function createRaceSfx(): RaceSfx {
  let braking = false;
  let lastLap = 0;
  let lastSignal = -1;
  const brakeHold: Repeater = { next: 0 };
  const scrape: Repeater = { next: 0 };

  return {
    reset() {
      braking = false;
      lastLap = 0;
      lastSignal = -1;
      brakeHold.next = 0;
      scrape.next = 0;
    },

    update(audio, profile, state) {
      const player: CarState | undefined = state.cars[0];
      if (!player) return;
      const now = audio.currentTime;
      const pan = profile.audio.positional ? player.lateral / VEHICLE.RUNOFF : undefined;
      const withPan = (extra: Record<string, unknown>) =>
        pan === undefined ? extra : { ...extra, pan };

      // ── スタートシグナル。残り 3 秒・2 秒・1 秒と GO で 1 発ずつ
      if (state.phase === 'countdown') {
        const remaining = Math.ceil(state.countdown / 60);
        if (remaining !== lastSignal) {
          lastSignal = remaining;
          audio.playOneShot({
            role: 'lead',
            frequency: remaining <= 1 ? SIGNAL.high : SIGNAL.low,
            when: now,
            durationSeconds: SIGNAL.duration,
            velocity: SIGNAL.velocity,
          });
        }
      } else if (lastSignal !== 0 && state.tick <= COUNTDOWN_TICKS + 1) {
        // GO。カウントダウンが終わった最初のティック
        lastSignal = 0;
        audio.playOneShot({
          role: 'lead',
          frequency: SIGNAL.high,
          when: now,
          durationSeconds: SIGNAL.duration * 2,
          velocity: 1,
        });
      }

      // ── ブレーキ。立ち上がりで一撃、保持中は擦過音
      const pressing = player.brakeInput > BRAKE_THRESHOLD && player.speed > 2;
      if (pressing && !braking) {
        audio.playOneShot({
          role: 'fx',
          frequency: BRAKE_HIT.frequency,
          when: now,
          durationSeconds: BRAKE_HIT.duration,
          velocity: BRAKE_HIT.velocity,
          ...withPan({}),
        });
        brakeHold.next = now;
      }
      braking = pressing;
      if (pressing) {
        repeat(audio, brakeHold, BRAKE_HOLD.intervalMs, (when) => {
          audio.playOneShot({
            role: 'fx',
            frequency: BRAKE_HOLD.frequency,
            when,
            durationSeconds: BRAKE_HOLD.duration,
            velocity: BRAKE_HOLD.velocity * Math.min(1, player.speed / 20),
            ...withPan({}),
          });
        });
      }

      // ── 路外。速度が乗っているほど強く鳴る
      if (player.offTrack && player.speed > 3) {
        repeat(audio, scrape, OFF_TRACK.intervalMs, (when) => {
          audio.playOneShot({
            role: 'perc',
            frequency: OFF_TRACK.frequency,
            when,
            durationSeconds: OFF_TRACK.duration,
            velocity: Math.min(0.7, 0.2 + player.speed / VEHICLE.MAX_SPEED),
            ...withPan({}),
          });
        });
      }

      // ── 接触。シムが 1 ティックだけ立てる種類で鳴らす
      if (player.hitKind !== 'none') {
        const impact = IMPACT[player.hitKind];
        audio.playOneShot({
          role: impact.role,
          frequency: impact.frequency,
          when: now,
          durationSeconds: impact.duration,
          velocity: Math.min(1, 0.25 + player.hitStrength / IMPACT_FULL_LOSS),
          ...withPan({}),
        });
      }

      // ── 周回通過
      if (player.lap > lastLap) {
        lastLap = player.lap;
        audio.playOneShot({
          role: 'lead',
          frequency: LAP.frequency,
          when: now,
          durationSeconds: LAP.duration,
          velocity: LAP.velocity,
        });
      }
    },
  };
}
