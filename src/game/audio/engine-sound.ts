import type { AudioService, HardwareGenerationProfile } from '@console-chaos/engine';

/**
 * エンジン音（実装計画 §4.3）。
 *
 * **エンジンに継続音の API は無い。** あるのは `playOneShot` だけで、
 * 「今から `when` 秒の時点で、この長さの音を 1 つ鳴らす」しか言えない。
 * だからエンジン音は**短い音を隙間なく予約し続けて**作る — 実機で回転音を
 * 作っていたやり方そのものである（当時も 1 音ずつ書き換えていた）。
 *
 * 予約は `AudioContext` の時計で先読みする。ゲームループが落ちても音は乱れない。
 */

/** 何秒先まで埋めるか。エンジンの `LOOKAHEAD_SECONDS`（0.12）より長く採る */
export const ENGINE_LOOKAHEAD_SECONDS = 0.2;

/** 1 回の更新で予約する上限。時計が飛んだときに無限ループへ入らないための蓋 */
const MAX_SCHEDULES_PER_UPDATE = 24;

/** 擬似ギアの段数。速度域を 4 つに割り、段の中で回転が上がって切替で落ちる */
export const GEAR_COUNT = 4;

/** 回転が上がるほど間隔を詰める [ms] */
const INTERVAL_MS = { idle: 110, redline: 60 } as const;

/** 基準周波数 [Hz]。`frequency = BASE_HZ * (0.6 + rpm * 2.4)` */
const BASE_HZ = 46;

/** 停車中でも回っている。完全に無音にはしない */
const IDLE_RPM = 0.18;

/** 音の長さは間隔より長く採り、隣どうしを重ねて途切れを消す */
const DURATION_RATIO = 1.6;

export interface EngineSoundInput {
  /** 速度 [m/s] */
  readonly speed: number;
  /** 最高速 [m/s] */
  readonly maxSpeed: number;
  /** アクセル 0..1 */
  readonly throttle: number;
  /** 路面外か。ざらついた音にするため回転を少し落とす */
  readonly offTrack: boolean;
  /** 定位 -1..1。定位を持たない世代では無視される */
  readonly pan?: number;
}

export interface EngineVoiceScheduler {
  /** 毎 `fixedUpdate` で呼ぶ。予約が先読み範囲を埋めるまで繰り返す */
  update(audio: AudioService, profile: HardwareGenerationProfile, input: EngineSoundInput): void;
  /** 予約位置を捨てる。曲の頭出しや画面遷移で使う */
  reset(): void;
  /** 直近に鳴らした回転数 0..1（テストと HUD 用） */
  readonly rpm: number;
  /** 直近のギア 0..3 */
  readonly gear: number;
}

/** 速度比 0..1 から擬似ギアを引く */
export function gearFor(speedRatio: number): number {
  const clamped = Math.min(0.999999, Math.max(0, speedRatio));
  return Math.floor(clamped * GEAR_COUNT);
}

/**
 * 速度比 0..1 から回転数 0..1 を作る。
 *
 * 段の中で 0 → 1 まで上がり、シフトアップで落ちる。**この鋸歯がギアの音**で、
 * 速度そのものを周波数へ写すと「ただ高くなるだけ」の音になる。
 */
export function rpmFor(speedRatio: number): number {
  const clamped = Math.min(0.999999, Math.max(0, speedRatio));
  const withinGear = clamped * GEAR_COUNT - gearFor(clamped);
  return IDLE_RPM + (1 - IDLE_RPM) * withinGear;
}

/**
 * 予約の間隔 [s]。回転が上がるほど詰める。
 *
 * **声数の少ない世代では間隔を空ける。** `playOneShot` は BGM より低い優先度で
 * 声を取るが、それでも第1世代の 5 声では隙間なく鳴らすと BGM のパートを食う。
 * 世代 ID ではなく `profile.audio.channels` から決めるので、分岐は 1 か所も要らない。
 */
export function intervalSecondsFor(rpm: number, profile: HardwareGenerationProfile): number {
  const base = INTERVAL_MS.idle + (INTERVAL_MS.redline - INTERVAL_MS.idle) * rpm;
  const scale = Math.min(2.2, Math.max(1, 12 / profile.audio.channels));
  return (base * scale) / 1000;
}

export function createEngineVoiceScheduler(): EngineVoiceScheduler {
  let nextTime = 0;
  let rpm = IDLE_RPM;
  let gear = 0;

  return {
    get rpm() {
      return rpm;
    },
    get gear() {
      return gear;
    },

    reset() {
      nextTime = 0;
    },

    update(audio, profile, input) {
      const now = audio.currentTime;
      // 解錠前は currentTime が進まない。予約だけ溜めても意味が無いので、
      // 追いついていなければ現在時刻へ引き戻す（起動直後と復帰時の両方で効く）
      if (nextTime < now) nextTime = now;

      const ratio = input.maxSpeed > 0 ? input.speed / input.maxSpeed : 0;
      gear = gearFor(ratio);
      rpm = rpmFor(ratio) * (input.offTrack ? 0.85 : 1);

      const interval = intervalSecondsFor(rpm, profile);
      const frequency = BASE_HZ * (0.6 + rpm * 2.4);
      // 空吹かしは軽く、負荷が掛かっているときは太く。アクセルの有無が音量に出る
      const velocity = 0.22 + 0.5 * input.throttle + 0.12 * rpm;

      const until = now + ENGINE_LOOKAHEAD_SECONDS;
      for (let count = 0; count < MAX_SCHEDULES_PER_UPDATE && nextTime < until; count++) {
        audio.playOneShot({
          role: 'fx',
          frequency,
          when: nextTime,
          durationSeconds: interval * DURATION_RATIO,
          velocity,
          ...(input.pan === undefined ? {} : { pan: input.pan }),
        });
        nextTime += interval;
      }
      // 上限に当たったら追いつくのを諦める（時計が飛んだ後の詰まりを残さない）
      if (nextTime < now) nextTime = now;
    },
  };
}
