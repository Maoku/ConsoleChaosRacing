import { createActionMap, defineActions, type ActionBindings } from '@console-chaos/engine';

/** 実装計画 §5.1。 */
export const ACTIONS = defineActions({
  steer: 'axis1d',
  throttle: 'button',
  brake: 'button',
  glance: 'button',
  genPrev: 'button',
  genNext: 'button',
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
  glance: { keys: ['ArrowUp'], gamepadButtons: [3] },
  genPrev: { keys: ['KeyQ'], gamepadButtons: [4] },
  genNext: { keys: ['KeyE'], gamepadButtons: [5] },
  pause: { keys: ['Escape'], gamepadButtons: [9] },
  // 決定はアクセルと同じキーで受ける。走り出すのと走らせ続けるのが同じ操作になる
  confirm: { keys: ['Enter', 'Space', 'KeyZ'], gamepadButtons: [0] },
  back: { keys: ['Backspace'], gamepadButtons: [1] },
};

export function createRacingActionMap() {
  return createActionMap(ACTIONS, BINDINGS);
}
