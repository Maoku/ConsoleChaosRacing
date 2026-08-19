import { FIXED_DT_SECONDS, createRng, mix32 } from '@console-chaos/engine';

import { TRACK, type Track } from './track.js';

/**
 * レースの状態（実装計画 §2.1）。
 *
 * `RaceSim` は描画も音も知らない。ここにある値だけがビューへ渡り、
 * 世代を切り替えてもこの状態には一切触れない。それを
 * `generation-invariance.spec.ts` が状態ハッシュで固定する。
 */

/** 出走台数（確定事項 §9-2） */
export const ENTRANT_COUNT = 8;
/** 周回数（確定事項 §9-2） */
export const LAP_COUNT = 3;
/** カウントダウンの長さ [tick]。3・2・1・GO の 4 秒 */
export const COUNTDOWN_TICKS = 240;

/**
 * バランス定数（バランス改修計画 §4.2 / §4.3）。
 *
 * ここにある数はすべて**現物のシムを回して測った値**で、コース形状と車両定数に依存する。
 * 手で書き換えず `npm run measure:pace` の出力で置き換えること。
 */
export const BALANCE = {
  /**
   * 敵車の速度モデル（最高速度と加速度の両方）に掛かる倍率。
   *
   * **要求は「走行中に実際に出る最高速度が自機の 0.95 倍」**であり、0.95 は
   * この定数ではなく**その結果として実測される比**である。最長の直線が 434 m しかない
   * このコースでは `MAX_SPEED` は終速の上限として一度も効かず、定数を 0.95 倍しても
   * 実測比は 0.971 にしかならない。二分探索で実測比が 0.950 になる値がこれ。
   */
  SPEED_SCALE: 0.933,
  /**
   * グリッドから GO して完走するまでと、飛び込み 3 周との差 [s]。
   * 目標レースタイムはこのぶんだけ 3 周ぶんのラップより長い
   */
  STANDING_START_SECONDS: 3.92,
  /** スタート時に目標タイムへ足すばらつきの幅 [s]（要求 R-2 b） */
  START_JITTER_SECONDS: 2,
} as const;

export type Difficulty = 'easy' | 'normal' | 'hard';

/**
 * 難易度（バランス改修計画 §4.3・D-7）。
 *
 * - `leaderLapSeconds` — 先頭（entrant 1）の目標ラップ [s]。ここだけで難易度が決まる
 * - `fieldSpreadSeconds` — 敵車 7 台のトップと最下位の目標レースタイムの差 [s]（要求 R-2 c）
 *
 * 基準は 2 つの実測アンカー: **理想** 69.90 s（AI が理想ラインをペース 1.0 で走った値。
 * 人間がこれを上回ることはほぼ無い）と **普通** 74.68 s。`normal` はその中間値、
 * `easy` は「普通」そのもの、`hard` は敵車スペックの AI の限界（71.48 s）＋ 0.4 s。
 *
 * **`hard` をこれ以上速くできないのは要求 R-1 の帰結**である。速度を自機の 0.95 に
 * 落とした車の限界が 71.48 s/周なので、`leaderLapSeconds` は 71.6 s より下へ行けない。
 */
export const DIFFICULTY: Record<
  Difficulty,
  { readonly leaderLapSeconds: number; readonly fieldSpreadSeconds: number }
> = {
  easy: { leaderLapSeconds: 74.7, fieldSpreadSeconds: 15 },
  normal: { leaderLapSeconds: 72.3, fieldSpreadSeconds: 15 },
  hard: { leaderLapSeconds: 71.9, fieldSpreadSeconds: 15 },
};

/** 目標タイムを持たない車（実操作の自機）の目印 */
export const NO_TARGET = -1;

/**
 * 敵車の目標レースタイム [tick]。GO から完走まで（決定 D-1）。
 *
 * グリッド順（前ほど速い）に `fieldSpreadSeconds` を 6 等分して配るので、
 * トップと最下位の差はきっかり要求どおりになる。`jitterSeconds` は要求 R-2 (b) の
 * 0〜+2 秒で、レース生成時に一度だけ決まる。
 */
export function targetRaceTicksFor(
  entrant: number,
  difficulty: Difficulty,
  jitterSeconds: number,
): number {
  const { leaderLapSeconds, fieldSpreadSeconds } = DIFFICULTY[difficulty];
  const rank = entrant - 1; // 0..6
  const lapSeconds = leaderLapSeconds + (rank * (fieldSpreadSeconds / LAP_COUNT)) / (ENTRANT_COUNT - 2);
  const raceSeconds =
    LAP_COUNT * lapSeconds + BALANCE.STANDING_START_SECONDS + jitterSeconds;
  return Math.round(raceSeconds / FIXED_DT_SECONDS);
}

export type RacePhase = 'countdown' | 'racing' | 'finished';

/**
 * 何に当たったか。`'none'` は当たっていない。
 *
 * 壁の材質を分けるのは 11-4。**接触した 1 ティックだけ立ち、次のティックで
 * `stepVehicle` が畳む**ので、読む側は立ち上がりを数えなくてよい。
 */
export type HitKind = 'none' | 'wall' | 'car';

export interface CarState {
  /** エントラント番号 0..7。0 が自機 */
  readonly entrant: number;
  /** 弧長 [m]。[0, trackLength) */
  s: number;
  /** 中心線からの右向き距離 [m] */
  lateral: number;
  /** 速度 [m/s]。常に非負（後退しない） */
  speed: number;
  /** 進行方向とコース接線の差 [rad]。右が正 */
  yaw: number;
  /** 完了した周回数。0 = まだスタートラインを越えていない */
  lap: number;
  /** lap * trackLength + s。順位はこの降順 */
  progress: number;
  /** 順位 1..8 */
  standing: number;
  /** 路面外に出ているか */
  offTrack: boolean;
  /**
   * この tick で何に当たったか（実装計画 11-3 / R-3・R-4）。
   * 真偽値ではなく種類を持つので、音は当たった相手ごとに変えられる。
   */
  hitKind: HitKind;
  /** その接触で失った速度 [m/s]。掠りは小さく、激突は大きい */
  hitStrength: number;
  /** 完走したか */
  finished: boolean;
  /** 完走した tick。未完走は -1 */
  finishTick: number;
  /** 現在の周が始まった tick。まだラインを越えていなければ -1 */
  lapStartTick: number;
  /** 完了した各周のティック数 */
  readonly lapTicks: number[];
  /** ベストラップのティック数。未計測は -1 */
  bestLapTicks: number;

  // ── ビューが読む派生値（シムの遷移には影響しない）
  /** 実際に効いた操舵 -1..1 */
  steerInput: number;
  throttleInput: number;
  brakeInput: number;
  /** 横加速度 [m/s²]。右が正。車体ロールの元 */
  lateralAccel: number;
  /** 前後加速度 [m/s²]。車体ピッチの元 */
  longitudinalAccel: number;

  // ── 車ごとの能力（生成時に決まり、以後変わらない）
  /**
   * 速度モデル全体に掛かる倍率。自機は 1、敵車は `BALANCE.SPEED_SCALE`。
   * `topSpeedOf()` / `accelOf()` からだけ読む
   */
  readonly speedScale: number;
  /**
   * 目標総レースタイム [tick]。GO から完走まで。持たない車は `NO_TARGET`。
   *
   * 順位の設計値そのもの。**上限ではない**ので、事故で失った時間を取り返すための
   * 「ゴム紐」は入れない（決定 D-6）
   */
  readonly targetRaceTicks: number;

  // ── AI の個体差（生成時に決まり、以後変わらない）
  /** 理想ラインの横方向オフセット [m] */
  readonly lineBias: number;
  /** 反応の鈍さ [tick] */
  readonly reactionTicks: number;

  // ── ペース制御の状態（毎ティック更新される派生値）
  /** 現在のペース倍率。AI の目標速度に掛かる。目標タイムから逆算される */
  pace: number;
}

export interface RaceState {
  readonly track: Track;
  readonly seed: number;
  tick: number;
  phase: RacePhase;
  /** カウントダウンの残り tick。racing 以降は 0 */
  countdown: number;
  /** 自機も AI が走らせる（タイトル画面のアトラクトデモ用） */
  autoPilot: boolean;
  readonly cars: CarState[];
  /** 順位順のエントラント番号。cars[standingOrder[0]] が首位 */
  readonly standingOrder: number[];
}

/**
 * アトラクトデモで自機に与える目標の相当エントラント。
 *
 * デモで自機だけ目標無し（＝常に全力）にすると、ポールスタートと相まって
 * **毎回同じ独走**になる。中位の目標を与えると、ポールから順位を下げてから
 * 中盤で競る画になる。自機のスペック（速度スケール 1）は変えない —
 * デモは「自機の車」を見せる場なので（バランス改修計画 §4.5）
 */
const DEMO_TARGET_ENTRANT = 4;

function createCar(
  entrant: number,
  track: Track,
  seed: number,
  difficulty: Difficulty,
  autoPilot: boolean,
): CarState {
  const rng = createRng(mix32(seed ^ (entrant * 0x9e3779b1)));
  // グリッドは 2 列。ポールが最も前（s が大きい ＝ スタートラインに近い）
  const row = Math.floor(entrant / 2);
  const column = entrant % 2;
  const s = track.wrapS(-8 - row * 11);
  const lateral = column === 0 ? -2.6 : 2.6;
  // 乱数の消費順は**廃止した `skill` の位置**に目標タイムのばらつきを置く。
  // こうすると `lineBias` / `reactionTicks` が 1 ビットも変わらず、走りの差分の原因を
  // 速度スケールと目標タイムだけに絞れる（バランス改修計画 リスク 6）
  const jitterSeconds = entrant === 0 ? 0 : rng.next() * BALANCE.START_JITTER_SECONDS;
  // 自機は実操作なら目標を持たない。アトラクトデモのときだけ中位の目標で走る
  const targetEntrant = entrant === 0 ? (autoPilot ? DEMO_TARGET_ENTRANT : 0) : entrant;

  return {
    entrant,
    s,
    lateral,
    speed: 0,
    yaw: 0,
    lap: 0,
    progress: 0,
    standing: entrant + 1,
    offTrack: false,
    hitKind: 'none',
    hitStrength: 0,
    finished: false,
    finishTick: -1,
    lapStartTick: -1,
    lapTicks: [],
    bestLapTicks: -1,
    steerInput: 0,
    throttleInput: 0,
    brakeInput: 0,
    lateralAccel: 0,
    longitudinalAccel: 0,
    // 自機（0）は自機のスペックのまま。敵車だけが 0.95 の実測比まで落ちる
    speedScale: entrant === 0 ? 1 : BALANCE.SPEED_SCALE,
    targetRaceTicks:
      targetEntrant === 0
        ? NO_TARGET
        : targetRaceTicksFor(targetEntrant, difficulty, jitterSeconds),
    // 自機（0）は個体差を持たない。AI だけがばらつく
    lineBias: entrant === 0 ? 0 : (rng.next() - 0.5) * 1.6,
    reactionTicks: entrant === 0 ? 0 : Math.floor(rng.next() * 6),
    pace: 1,
  };
}

export interface CreateRaceOptions {
  readonly seed?: number;
  readonly track?: Track;
  readonly autoPilot?: boolean;
  /** 敵車の目標タイムの厳しさ。既定は `'normal'`（決定 D-7） */
  readonly difficulty?: Difficulty;
}

export function createRaceState(options: CreateRaceOptions = {}): RaceState {
  const track = options.track ?? TRACK;
  const seed = options.seed ?? 20260812;
  const difficulty = options.difficulty ?? 'normal';
  const autoPilot = options.autoPilot ?? false;
  const cars: CarState[] = [];
  for (let entrant = 0; entrant < ENTRANT_COUNT; entrant++) {
    cars.push(createCar(entrant, track, seed, difficulty, autoPilot));
  }
  for (const car of cars) {
    car.progress = car.lap * track.length + car.s - track.length;
  }
  return {
    track,
    seed,
    tick: 0,
    phase: 'countdown',
    countdown: COUNTDOWN_TICKS,
    autoPilot,
    cars,
    standingOrder: cars.map((car) => car.entrant),
  };
}

/**
 * 決定論テスト用の状態ハッシュ。
 *
 * 浮動小数をそのまま混ぜると環境差が出るので 1/4096 m 刻みへ量子化する。
 * 世代切替で状態が動いていないことは、この 1 つの数値で確認できる。
 */
export function hashRaceState(state: RaceState): number {
  let hash = 2166136261;
  const push = (value: number): void => {
    hash = mix32(hash ^ (Math.round(value * 4096) | 0));
  };

  push(state.tick);
  push(state.countdown);
  push(state.phase === 'countdown' ? 0 : state.phase === 'racing' ? 1 : 2);
  for (const car of state.cars) {
    push(car.entrant);
    push(car.s);
    push(car.lateral);
    push(car.speed);
    push(car.yaw);
    push(car.lap);
    push(car.standing);
    push(car.finished ? 1 : 0);
    push(car.finishTick);
    push(car.bestLapTicks);
    push(car.lapTicks.length);
    for (const ticks of car.lapTicks) push(ticks);
  }
  return hash >>> 0;
}
