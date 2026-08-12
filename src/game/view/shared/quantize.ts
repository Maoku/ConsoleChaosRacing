import { FIXED_HZ, type HardwareGenerationProfile } from '@console-chaos/engine';

/**
 * 「見た目の更新レート」の量子化（実装計画 §3 冒頭）。
 *
 * レンダラーが `profile.video.animationHz` を自動適用するのは
 * `SkinnedMeshCommand.animationTime` の量子化のみで、本作の車は skin を持たない
 * 非スキンメッシュとスプライトである。したがって FC の 6Hz・SFC の 12Hz といった
 * カクつきは**ゲーム側の責務**であり、全ビューがこの関数を必ず経由する。
 */
export function quantizeTime(seconds: number, profile: HardwareGenerationProfile): number {
  const hz = profile.video.animationHz;
  if (!Number.isFinite(hz) || hz <= 0) return seconds;
  return Math.floor(seconds * hz) / hz;
}

/** 量子化された時刻で数える、単調増加のフレーム番号。スプライトのコマ送りに使う。 */
export function quantizedFrame(seconds: number, profile: HardwareGenerationProfile): number {
  const hz = profile.video.animationHz;
  if (!Number.isFinite(hz) || hz <= 0) return Math.floor(seconds * 60);
  return Math.floor(seconds * hz);
}

/**
 * 背景・スプライトの配置座標をタイル境界へ丸める（能力契約 `tileSnap`、実装計画 §1.4）。
 * FC は 8px、それ以外は 1px なので、この関数は世代 ID を見ずに丸めを切り替えられる。
 */
export function snapToTile(value: number, profile: HardwareGenerationProfile): number {
  const snap = profile.video.tileSnap;
  if (!Number.isFinite(snap) || snap <= 1) return value;
  return Math.round(value / snap) * snap;
}

/** 2 値をまとめて丸める版。スプライト座標に使う。 */
export function snapPointToTile(
  x: number,
  y: number,
  profile: HardwareGenerationProfile,
): [number, number] {
  return [snapToTile(x, profile), snapToTile(y, profile)];
}

/**
 * ティック番号から、その世代の表示フレーム番号を求める。
 *
 * 秒からの `quantizedFrame()` と違って整数演算だけで済むので、境目で 1 フレーム
 * 取りこぼす（60Hz の世代で 60 回のはずが 59 回になる）ことがない。
 * 表示のラッチはこちらを使う。
 */
export function displayFrameForTick(tick: number, profile: HardwareGenerationProfile): number {
  const hz = profile.video.animationHz;
  if (!Number.isFinite(hz) || hz <= 0) return tick;
  return Math.floor((tick * hz) / FIXED_HZ);
}

/**
 * 60Hz のティック番号を、その世代の更新レートの境界へ切り下げる。
 *
 * 「どの瞬間のシム状態を見せるか」を決めるために使う。シムは常に 60Hz で回り、
 * ビューは切り下げたティックの状態だけを見る。FC は 10 ティックに 1 回しか
 * 表示が変わらない（60 / 6 = 10）。
 */
export function quantizeTick(tick: number, profile: HardwareGenerationProfile): number {
  const hz = profile.video.animationHz;
  if (!Number.isFinite(hz) || hz <= 0 || hz >= 60) return tick;
  const ticksPerFrame = 60 / hz;
  return Math.floor(tick / ticksPerFrame) * ticksPerFrame;
}
