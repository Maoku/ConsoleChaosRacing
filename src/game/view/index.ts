import {
  defineGenerationVariant,
  generationValue,
  type GenerationVariant,
  type RenderFrame,
} from '@console-chaos/engine';

import type { ViewBuilder, ViewContext } from './context.js';
import { buildGen1View } from './gen1-fc.js';
import { buildGen2View } from './gen2-sfc.js';
import { buildGen3View } from './gen3-ps1.js';
import { buildGen4View } from './gen4-ps2.js';
import { pushScreenOverlay } from './overlay.js';

/**
 * GenerationId → ビューの割り当て（実装計画 §2.1）。
 *
 * **世代分岐はこの 1 か所のテーブルだけ。** ビューの分割は「世代 ID の分岐」ではなく
 * 「表現手法ごとのモジュール分割」であり、各ビューの中では世代 ID を見ない
 * （見るのは `HardwareGenerationProfile` の能力値と variant テーブル）。
 *
 * 4 世代とも専用のビューが揃った。表現手法は
 * ラスター / アフィン / ordering table の 3D / 深度バッファの 3D と別物だが、
 * 受け取る `ViewContext` は 4 つとも同じで、シムには誰も触れない。
 */
const VIEWS: GenerationVariant<ViewBuilder> = defineGenerationVariant({
  FC: buildGen1View,
  SFC: buildGen2View,
  PS1: buildGen3View,
  PS2: buildGen4View,
});

export function buildGenerationView(frame: RenderFrame, context: ViewContext): void {
  generationValue(VIEWS, context.generation)(frame, context);
  // 画面の文字（タイトル・カウントダウン・ポーズ・リザルト）は最後に積む。
  // ビューの後なので必ず最前面になり、第1世代でも走査線制限の対象外になる
  // — 実機で BG タイル面に描かれていたものと同じ扱い（§3.6）
  pushScreenOverlay(frame, context);
}

export type { ViewBuilder, ViewContext } from './context.js';
