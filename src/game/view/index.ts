import {
  defineGenerationVariant,
  generationValue,
  type GenerationVariant,
  type RenderFrame,
} from '@console-chaos/engine';

import type { ViewBuilder, ViewContext } from './context.js';
import { buildGen3View } from './gen3-ps1.js';
import { buildPlaceholderView } from './placeholder.js';

/**
 * GenerationId → ビューの割り当て（実装計画 §2.1）。
 *
 * **世代分岐はこの 1 か所のテーブルだけ。** ビューの分割は「世代 ID の分岐」ではなく
 * 「表現手法ごとのモジュール分割」であり、各ビューの中では世代 ID を見ない
 * （見るのは `HardwareGenerationProfile` の能力値と variant テーブル）。
 *
 * まだ実装していない世代は暫定表示（空＋全画面ミニマップ）に割り当ててある。
 * フェーズが進むたびにここを 1 行ずつ差し替えていく。
 */
const VIEWS: GenerationVariant<ViewBuilder> = defineGenerationVariant({
  FC: buildPlaceholderView, // フェーズ 3 で view/gen1-fc.ts へ
  SFC: buildPlaceholderView, // フェーズ 4 で view/gen2-sfc.ts へ
  PS1: buildGen3View,
  PS2: buildPlaceholderView, // フェーズ 5 で view/gen4-ps2.ts へ
});

export function buildGenerationView(frame: RenderFrame, context: ViewContext): void {
  generationValue(VIEWS, context.generation)(frame, context);
}

export type { ViewBuilder, ViewContext } from './context.js';
