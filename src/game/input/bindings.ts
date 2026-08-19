import {
  GENERATION_IDS,
  createActionMap,
  defineActions,
  type ActionBindings,
  type ActionSnapshot,
  type ButtonActionValue,
  type GenerationId,
} from '@console-chaos/engine';

/** 実装計画 §5.1。 */
export const ACTIONS = defineActions({
  steer: 'axis1d',
  throttle: 'button',
  brake: 'button',
  /**
   * 視点の切り替え（実装計画 8-5）。第3・第4世代でだけ効く。
   * 未実装のまま枠だけ残っていた `glance`（後方確認）を置き換えたもので、
   * **実装しない機能の枠は残さない**
   */
  viewCycle: 'button',
  genPrev: 'button',
  genNext: 'button',
  /** 世代の直接指定（実装計画 8-7）。番号は HUD のチャンネル表記と対応する */
  genSelect1: 'button',
  genSelect2: 'button',
  genSelect3: 'button',
  genSelect4: 'button',
  /**
   * 画面モード（実装計画 11-7）。世代切替と同じで**どの画面でも効く**。
   * フラットディスプレイ（樽型歪み）とモアレ（走査線 ＋ 蛍光体マスク）。
   */
  toggleFlat: 'button',
  toggleMoire: 'button',
  pause: 'button',
  /** 決定。タイトルから走り出す・リザルトからリトライ・ポーズを解く */
  confirm: 'button',
  /** 戻る。どの画面からでもタイトルへ */
  back: 'button',
});

export type RacingActions = typeof ACTIONS;

/**
 * `holdRampMs` はキーボード押下時間から 0..1 のアナログ量を作る。
 * 世代で入力の作法が変わるが（`dpad4` では斜めが落ち、`analog` ではスティックが直接効く）、
 * 差が挙動を変えすぎないよう ramp は短め（180ms）に取る。
 */
const BINDINGS: ActionBindings<RacingActions> = {
  steer: {
    negativeKeys: ['ArrowLeft', 'KeyA'],
    positiveKeys: ['ArrowRight', 'KeyD'],
    gamepadAxis: 0,
  },
  throttle: { keys: ['KeyZ', 'Space'], gamepadButtons: [0], holdRampMs: 180 },
  brake: { keys: ['KeyX', 'ArrowDown'], gamepadButtons: [1], holdRampMs: 180 },
  viewCycle: { keys: ['KeyC'], gamepadButtons: [3] },
  genPrev: { keys: ['KeyQ'], gamepadButtons: [4] },
  genNext: { keys: ['KeyE'], gamepadButtons: [5] },
  // ゲームパッドには割り当てない。4 ボタンを世代へ潰すと運転の操作が足りなくなる
  genSelect1: { keys: ['Digit1', 'Numpad1'] },
  genSelect2: { keys: ['Digit2', 'Numpad2'] },
  genSelect3: { keys: ['Digit3', 'Numpad3'] },
  genSelect4: { keys: ['Digit4', 'Numpad4'] },
  // ゲームパッドには割り当てない。画面モードは腰を据えて選ぶ設定で、
  // 運転しながら触るものではない
  toggleFlat: { keys: ['KeyF'] },
  toggleMoire: { keys: ['KeyM'] },
  pause: { keys: ['Escape'], gamepadButtons: [9] },
  // 決定はアクセルと同じキーで受ける。走り出すのと走らせ続けるのが同じ操作になる
  confirm: { keys: ['Enter', 'Space', 'KeyZ'], gamepadButtons: [0] },
  back: { keys: ['Backspace'], gamepadButtons: [1] },
};

/**
 * 世代を直接指定するアクション。並びは `GENERATION_IDS` と 1 対 1 で、
 * **`n` 番目のキーが `n` 番目の世代**になる（HUD の `CH n : ...` と同じ番号）。
 */
export const GENERATION_SELECT_ACTIONS = [
  'genSelect1',
  'genSelect2',
  'genSelect3',
  'genSelect4',
] as const satisfies readonly (keyof RacingActions)[];

/**
 * このフレームに要求された世代（実装計画 8-7）。押されていなければ `null`。
 *
 * 世代の順送り（Q / E）と直接指定は用途が違うので**両方残す** —
 * アトラクトデモを順に眺めるのと、見たい世代へ跳ぶのは別の操作である。
 * すでに表示中の世代を要求しても `GenerationController.request()` が偽を返すだけで
 * 演出は起きないので、ここでは同一世代を弾かない。
 */
export function requestedGeneration(
  input: Pick<ActionSnapshot<RacingActions>, (typeof GENERATION_SELECT_ACTIONS)[number]>,
): GenerationId | null {
  for (let index = 0; index < GENERATION_SELECT_ACTIONS.length; index++) {
    const action = input[GENERATION_SELECT_ACTIONS[index]!] as ButtonActionValue;
    if (action.pressed) return GENERATION_IDS[index]!;
  }
  return null;
}

export function createRacingActionMap() {
  return createActionMap(ACTIONS, BINDINGS);
}
