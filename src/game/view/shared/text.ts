import {
  type GenerationId,
  type HardwareBlendCommand,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import {
  FILL_CHAR_CODE,
  FONT_ATLAS,
  fontAdvance,
  fontCell,
  measureText,
} from './font.js';

/**
 * 文字列 → スクリーン空間スプライト（実装計画 §3.5）。
 *
 * `OverlayCommand` は WebGL レンダラーで描かれないので、文字はここを通る。
 * HUD・タイトル・カウントダウン・リザルトが 4 世代とも**同じ 1 本の経路**に乗り、
 * 世代差は色・拡大率・字送り・半透明の作法だけになる。
 *
 * 積んだ順がそのまま重ね順になる（スクリーン空間スプライトは第3世代では
 * ordering table の固定スロット 10、第4世代ではシーン末尾へ合成される）。
 */

export type TextAlign = 'left' | 'center' | 'right';

export interface TextShadow {
  /** ずらす画素数（拡大前） */
  readonly offset: number;
  readonly color: string;
}

export interface TextOptions {
  /** スプライト id の接頭辞。1 文字ごとに連番が付く */
  readonly id: string;
  readonly text: string;
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  /** 基準点の X [px]。`align` がどこを指すかを決める */
  readonly x: number;
  /** 字形の**上端**の Y [px] */
  readonly y: number;
  readonly color: string;
  readonly align?: TextAlign;
  /** 拡大率（整数）。既定は 1 */
  readonly scale?: number;
  readonly shadow?: TextShadow | null;
  readonly layer?: number;
  /** 半透明の作法。`translucency` を持つ世代でだけ渡すこと */
  readonly hardwareBlend?: HardwareBlendCommand;
}

/** 描画される文字列の外形 [px]。パネルの寸法を決めるのに使う */
export interface TextBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/** 基準点と揃えから、字形の左上の X を求める */
function originX(options: TextOptions, width: number): number {
  switch (options.align ?? 'left') {
    case 'right':
      return options.x - width;
    case 'center':
      return options.x - width / 2;
    default:
      return options.x;
  }
}

export function textBounds(options: TextOptions): TextBounds {
  const scale = options.scale ?? 1;
  const advance = fontAdvance(options.profile.video.tileSnap);
  const width = measureText(options.text, scale, advance);
  return {
    left: originX(options, width),
    top: options.y,
    width,
    height: FONT_ATLAS.glyphHeight * scale,
  };
}

/**
 * 1 文字 = 1 スプライト。
 *
 * セルは 8² だが字形は左上の 5×7 しか使わないので、字送りをセルの一辺より狭く
 * 採っても隣の字を消さない（余りは透明で、`alphaCutoff` に捨てられる）。
 */
export function textSprites(options: TextOptions): SpriteCommand[] {
  const scale = options.scale ?? 1;
  const advance = fontAdvance(options.profile.video.tileSnap);
  const bounds = textBounds(options);
  const size = FONT_ATLAS.cell * scale;
  const layer = options.layer ?? 50;
  const sprites: SpriteCommand[] = [];

  const emit = (offsetX: number, offsetY: number, color: string, suffix: string): void => {
    for (let index = 0; index < options.text.length; index++) {
      const cell = fontCell(options.text.charCodeAt(index));
      if (cell === null || cell === 0) continue; // 空白はスプライトを積まない
      const left = bounds.left + index * advance * scale + offsetX;
      sprites.push({
        id: `${options.id}-${suffix}${index}`,
        screenSpace: true,
        // 位置はスプライトの中心。字形はセルの左上にあるので、
        // 中心はセルの左上から半セルぶん右下になる
        position: [left + size / 2, bounds.top + offsetY + size / 2, 0],
        size: [size, size],
        color,
        texture: FONT_ATLAS.url,
        cell,
        alphaCutoff: 0.5,
        layer,
        ...(options.hardwareBlend ? { hardwareBlend: options.hardwareBlend } : {}),
        generations: [options.generation],
      });
    }
  };

  // 影を先に積む（後に積んだものが手前）
  if (options.shadow) {
    const offset = options.shadow.offset * scale;
    emit(offset, offset, options.shadow.color, 's');
  }
  emit(0, 0, options.color, '');

  return sprites;
}

export interface PanelOptions {
  readonly id: string;
  readonly generation: GenerationId;
  readonly rect: TextBounds;
  readonly color: string;
  readonly layer?: number;
  /** 半透明の作法。`translucency` を持つ世代でだけ渡すこと */
  readonly hardwareBlend?: HardwareBlendCommand;
}

/**
 * 単色の矩形。フォントアトラスの塗りつぶしセル（0x7F）を引き伸ばして出す。
 *
 * スプライトはアトラス経由でしか描けないので、矩形 1 枚にもアトラスが要る。
 * 文字と同じ 1 枚で済ませられるのは、生成時にこのセルを空けておいたため。
 */
export function panelSprite(options: PanelOptions): SpriteCommand {
  const { rect } = options;
  return {
    id: options.id,
    screenSpace: true,
    position: [rect.left + rect.width / 2, rect.top + rect.height / 2, 0],
    size: [rect.width, rect.height],
    color: options.color,
    texture: FONT_ATLAS.url,
    cell: fontCell(FILL_CHAR_CODE)!,
    alphaCutoff: 0.5,
    layer: options.layer ?? 49,
    ...(options.hardwareBlend ? { hardwareBlend: options.hardwareBlend } : {}),
    generations: [options.generation],
  };
}
