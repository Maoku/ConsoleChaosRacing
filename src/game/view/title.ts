import {
  defineGenerationVariant,
  generationValue,
  type GenerationVariant,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { ViewContext } from './context.js';
import {
  centeredBlock,
  centeredBlockHeight,
  centeredBlockPadding,
  screenCenterX,
  type CenteredLine,
} from './shared/centered-text.js';
import { FONT_ATLAS, LOGO_ATLAS, fontAdvance, measureText } from './shared/font.js';
import { GENERATION_LABELS, TEXT_STYLES } from './shared/hud.js';
import { defaultMinimapRect } from './shared/minimap.js';
import { ceilToTile, floorToTile } from './shared/quantize.js';
import { panelSprite, textSprites } from './shared/text.js';
import { safeAreaOf } from './shared/variants.js';

/**
 * タイトル画面（実装計画 §3.7）。
 *
 * **ここが本作の掴みになる。** プレイヤーは走り出す前に、タイトル画面を
 * 切り替えるだけで 4 世代の違いを体験できる。
 *
 * 画は 4 つの層でできている。
 *
 * 1. **アトラクトデモ** — その世代のビューがそのまま背景になる。専用の描画は 1 つも無い。
 *    AI 8 台のレースが背後で走り続け、世代を切り替えると表現だけが変わる（§5.2）
 * 2. **ロゴ** — `common/logo.png` を 1 枚。FC では 54 色へ、SFC では RGB555 へ
 *    レンダラーが量子化するので、**世代ごとに焼き分けていない**（§3.7）
 * 3. **PRESS START** — その世代の更新レートで明滅する。FC の 6Hz と PS2 の 60Hz で
 *    点滅の粒が違って見える
 * 4. **操作説明** — 左下。ミニマップ（右下）と横に並ぶ
 *
 * ## 配置は割合ではなく**ミニマップの矩形から決める**
 *
 * 世代ごとに内部解像度もミニマップの大きさも違うので、画面高に対する割合で
 * 置くと必ずどこかの世代で重なる（第4世代は 176² のミニマップが画面の 4 割を占める）。
 * そこで PRESS START の塊は**ミニマップの上端のすぐ上**へ底を合わせ、
 * ロゴはその上に残った空間の中央へ置く。世代を跨いで自動的に収まり、
 * ミニマップの寸法を変えても追従する（`screen-layout.spec.ts` が重なりを固定する）。
 */

interface TitleLayout {
  /** ロゴの拡大率（整数）。内部解像度が上がる世代だけ大きくする */
  readonly logoScale: number;
}

const TITLE_LAYOUTS: GenerationVariant<TitleLayout> = defineGenerationVariant({
  FC: { logoScale: 1 },
  SFC: { logoScale: 1 },
  PS1: { logoScale: 1 },
  PS2: { logoScale: 2 },
});

/** 明滅の速さ [Hz]。値そのものより、**世代の更新レートで量子化される**ことが要点 */
const BLINK_HZ = 1.6;

/** ミニマップの上端との間に空ける隙間 [px]（拡大前） */
const MINIMAP_GAP = 4;

/**
 * 操作説明。ミニマップの左端に収まる長さに切ってある。
 *
 * 2 行目に `1-4` を並べてあるのは 8-7 で足した世代の直接指定で、
 * HUD の `CH n : NTH GEN` と番号が対応する — **チャンネルを回す**という
 * 見立てが、操作説明・HUD・キーの 3 か所で揃う。
 */
const CONTROLS = ['Z ACCEL  X BRAKE', 'Q E 1-4: CHANNEL'] as const;

export function titleSprites(context: ViewContext): SpriteCommand[] {
  const { generation, profile, display } = context;
  const style = generationValue(TEXT_STYLES, generation);
  const layout = generationValue(TITLE_LAYOUTS, generation);
  const safe = safeAreaOf(profile);
  const minimap = defaultMinimapRect(generation, profile);
  const sprites: SpriteCommand[] = [];

  // ── PRESS START の塊。底をミニマップの上端へ合わせる
  const lit = Math.floor(display.seconds * BLINK_HZ) % 2 === 0;
  const promptLines: CenteredLine[] = [
    { text: 'PRESS START', scale: 2, visible: lit },
    {
      text: generationValue(GENERATION_LABELS, generation),
      scale: 1,
      emphasis: false,
      gapBefore: 6,
    },
  ];
  const padding = centeredBlockPadding(style);
  const promptHeight = centeredBlockHeight(promptLines, style);
  const promptBottom = minimap.top - MINIMAP_GAP * style.scale;
  const promptTop = floorToTile(promptBottom - padding - promptHeight, profile);

  // ── ロゴ。塊の上に残った空間の中央へ置く（安全領域より上へは出さない）
  const logoWidth = LOGO_ATLAS.width * layout.logoScale;
  const logoHeight = LOGO_ATLAS.height * layout.logoScale;
  const logoLeft = floorToTile(screenCenterX(profile) - logoWidth / 2, profile);
  const logoTop = Math.max(
    ceilToTile(safe.top, profile),
    floorToTile((promptTop - padding - logoHeight) / 2, profile),
  );
  sprites.push({
    id: `screen-logo-${generation}`,
    screenSpace: true,
    position: [logoLeft + logoWidth / 2, logoTop + logoHeight / 2, 0],
    size: [logoWidth, logoHeight],
    color: '#ffffff',
    texture: LOGO_ATLAS.url,
    cell: 0,
    alphaCutoff: 0.5,
    layer: 60,
    generations: [generation],
  });

  // パネルを敷くのは、背後でアトラクトデモが動いているため。文字だけを置くと
  // 路面や雲の上で読めなくなる（実画面で確認）。`translucency` を持たない世代では
  // **不透明の帯**になる — 実機の FC のタイトルも文字の下に単色の帯を置いていた。
  // パネルは点滅させないので、PRESS START が消えている間も居場所が分かる
  for (const sprite of centeredBlock({
    id: 'title-prompt',
    context,
    style,
    panel: true,
    top: promptTop,
    lines: promptLines,
  }).sprites) {
    sprites.push(sprite);
  }

  for (const sprite of controlsSprites(context)) sprites.push(sprite);
  return sprites;
}

/**
 * 操作説明は**左下に左揃え**で置く。
 *
 * 中央寄せにするとミニマップ（右下）と必ず重なる。左下に寄せておけば、
 * ミニマップの左端までの幅に収まっているかぎり 4 世代とも衝突しない。
 */
function controlsSprites(context: ViewContext): SpriteCommand[] {
  const { generation, profile } = context;
  const style = generationValue(TEXT_STYLES, generation);
  const safe = safeAreaOf(profile);
  const advance = fontAdvance(profile.video.tileSnap);
  const pitch = style.linePitch * style.scale;
  const glyphHeight = FONT_ATLAS.glyphHeight * style.scale;
  const height = (CONTROLS.length - 1) * pitch + glyphHeight;
  const width = Math.max(...CONTROLS.map((text) => measureText(text, style.scale, advance)));

  const left = ceilToTile(safe.left, profile);
  const top = floorToTile(safe.top + safe.height - height, profile);
  const padding = Math.max(2, style.padding) * style.scale;

  const sprites: SpriteCommand[] = [
    panelSprite({
      id: `screen-panel-${generation}-title-controls`,
      generation,
      rect: {
        left: left - padding,
        top: top - padding,
        width: width + padding * 2,
        height: height + padding * 2,
      },
      color: style.panel?.color ?? '#101018',
      layer: 59,
      ...(style.panel ? { hardwareBlend: style.panel.blend } : {}),
    }),
  ];

  CONTROLS.forEach((text, index) => {
    for (const sprite of textSprites({
      id: `screen-${generation}-title-controls-${index}`,
      text,
      generation,
      profile,
      x: left,
      y: top + index * pitch,
      color: style.label,
      scale: style.scale,
      shadow: style.shadow,
      layer: 60,
    })) {
      sprites.push(sprite);
    }
  });

  return sprites;
}
