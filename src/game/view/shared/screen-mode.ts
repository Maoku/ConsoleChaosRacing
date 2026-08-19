/**
 * 画面モード（実装計画 11-7 / R-7 / D-13・D-14・D-15）。
 *
 * CRT は**1 本のシェーダ ＋ 7 つの uniform**で、値は信号系統ごとのプリセットである。
 * ここで作るのはそのプリセットへの**上書き**だけで、レンダラーは毎フレーム
 * `crtOverride()` を評価するので、切り替えても作り直しは要らない。
 *
 * | 設定 | 既定 | 上書き |
 * | --- | --- | --- |
 * | フラットディスプレイ | OFF（ブラウン管の丸みあり） | ON のとき `{ curvature: 0 }` |
 * | モアレ | ON（走査線と蛍光体マスクあり） | OFF のとき `{ mask: 0, scanline: 0 }` |
 *
 * **既定は「いまの見え方」**にする。初回起動の絵が変わらないことがこの機能の
 * 受け入れ条件でもあるので、既定の上書きは**空**になる。
 *
 * 「モアレ」が 2 つの uniform を指すのは、**どちらも出力画素の周期を持つ模様**
 * だからである（D-13）。蛍光体マスクは `mod(gl_FragCoord.x, 3.0)` の 3 本周期で、
 * 表示側の画素格子と干渉してうなりに見える主因。走査線は太さを出力画素の整数倍へ
 * 丸めてあるので本ごとの揺れは無いが、縞そのものは残る。
 *
 * 「フラットディスプレイ」は樽型歪み（`uCurvature`）だけを 0 にする（D-14）。
 * にじみ・ブルーム・ビネットは残す — それらは平面パネルの CRT フィルタでも
 * 普通に出す絵作りであり、**2 つの設定は重ならない**。
 */

/** CRT プリセットへの上書き。エンジンの `Partial<CrtPreset>` と構造的に一致する */
export interface CrtOverride {
  scanline?: number;
  bleed?: number;
  curvature?: number;
  bloom?: number;
  vignette?: number;
  noise?: number;
  mask?: number;
}

export interface ScreenModeState {
  /** 真なら樽型歪みを 0 にする ＝ 平面パネル */
  readonly flatDisplay: boolean;
  /** 偽なら蛍光体マスクと走査線を 0 にする ＝ 画素周期の模様を消す */
  readonly moire: boolean;
}

export interface ScreenMode extends ScreenModeState {
  toggleFlatDisplay(): void;
  toggleMoire(): void;
  /** レンダラーへ毎フレーム渡す上書き。既定（丸みあり・モアレあり）では空 */
  crtOverride(): CrtOverride;
}

/** 既定 ＝ いまの見え方。ブラウン管の丸みも走査線も蛍光体マスクもそのまま */
export const DEFAULT_SCREEN_MODE: ScreenModeState = { flatDisplay: false, moire: true };

/**
 * 状態 → 上書き。**2 つの設定は独立している**ので、単純な合成で足りる。
 * 純関数なので、これだけを単体でテストできる（リスク 9）。
 */
export function screenModeOverride(state: ScreenModeState): CrtOverride {
  return {
    ...(state.flatDisplay ? { curvature: 0 } : {}),
    ...(state.moire ? {} : { mask: 0, scanline: 0 }),
  };
}

/** 表示用の文字。ポーズ画面とタイトルの操作説明が読む */
export function screenModeLabel(state: ScreenModeState): string {
  return `F FLAT ${state.flatDisplay ? 'ON' : 'OFF'}  M MOIRE ${state.moire ? 'ON' : 'OFF'}`;
}

export function createScreenMode(initial: Partial<ScreenModeState> = {}): ScreenMode {
  const state = {
    flatDisplay: initial.flatDisplay ?? DEFAULT_SCREEN_MODE.flatDisplay,
    moire: initial.moire ?? DEFAULT_SCREEN_MODE.moire,
  };
  return {
    get flatDisplay() {
      return state.flatDisplay;
    },
    get moire() {
      return state.moire;
    },
    toggleFlatDisplay() {
      state.flatDisplay = !state.flatDisplay;
    },
    toggleMoire() {
      state.moire = !state.moire;
    },
    crtOverride: () => screenModeOverride(state),
  };
}
