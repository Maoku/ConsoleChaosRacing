import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareBlendCommand,
  type HardwareGenerationProfile,
  type RenderFrame,
  type SpriteCommand,
} from '@console-chaos/engine';

import { showsRaceHud, type ScreenId } from '../../flow/screens.js';
import { formatLapTime } from '../../sim/race.js';
import { ENTRANT_COUNT, LAP_COUNT } from '../../sim/state.js';
import type { DisplayCar, DisplaySnapshot } from './display-state.js';
import { FONT_ATLAS, fontAdvance, measureText } from './font.js';
import { ceilToTile, floorToTile } from './quantize.js';
import { panelSprite, textSprites, type TextShadow } from './text.js';
import { PLAYER_ENTRANT, safeAreaOf } from './variants.js';

/**
 * 走行中の HUD（実装計画 §3.5）。
 *
 * 4 世代とも**同じ内容・同じ組み立て**で、違うのは色数・拡大率・字送り・
 * 半透明の作法だけである。ミニマップが「同じ位置を 4 通りに描く」装置なら、
 * こちらは「同じ数字を 4 通りに描く」装置になる。
 *
 * - **FC** — 単色 2 段。`translucency: none` なのでパネルも影も置かない。
 *   字送りは `tileSnap` から 8 px になり、実機の BG タイル面の HUD と同じ字間になる
 * - **SFC** — 影付き 2 色。字送りは 6 px に詰まる
 * - **PS1 / PS2** — 半透明パネル。PS1 は 4 固定係数の average、PS2 は GS の任意不透明度
 *
 * 文字とパネルは実機では BG タイル面に描かれ、スプライト枠を消費しなかった。
 * 本エンジンにはタイル面が無いのでスプライトで代用するが、
 * **`applyScanlineLimit` の対象外**として扱う（§3.6 の決定。`sprite-plane.ts` の `foreground`）。
 *
 * 3 つの塊はすべて**左揃え**にする。タイル境界を持つ世代では字送りがタイルの一辺
 * そのものなので、塊の左端さえ境界へ載れば全部の文字がタイルへ載る。
 * 右揃えにすると、字形の幅（5 px）とタイル（8 px）の差だけ格子から外れる。
 * ラップタイムの 2 行を `TIME` / `BEST` と同じ字数にしてあるのは、
 * 左揃えのままで数字の桁を縦に揃えるためである。
 */

/**
 * 画面に出る文字の世代差。**HUD だけでなく、タイトル・カウントダウン・
 * リザルトもこの 1 つの表を通る**（`view/overlay.ts` / `view/title.ts`）。
 *
 * どの画面でも「FC は単色でパネル無し、SFC は影付き 2 色、PS1・PS2 は半透明パネル」
 * が揃うので、画面を移っても世代の性格が変わらない。
 */
export interface TextStyle {
  /** 拡大率。内部解像度が上がる世代だけ大きくする */
  readonly scale: number;
  /** ラベル（POS / LAP / BEST など、添え物）の色 */
  readonly label: string;
  /** 主役の色。FC はラベルと同じ ＝ **単色** */
  readonly value: string;
  readonly shadow: TextShadow | null;
  /** 背景パネル。`null` なら置かない（FC は `translucency: none`） */
  readonly panel: { readonly color: string; readonly blend: HardwareBlendCommand } | null;
  /** パネルが文字の外へ広がる量 [px]（拡大前） */
  readonly padding: number;
  /** 行送り [px]（拡大前）。FC はタイル 1 行ぶん */
  readonly linePitch: number;
}

export const TEXT_STYLES: GenerationVariant<TextStyle> = defineGenerationVariant({
  FC: {
    scale: 1,
    label: '#fcfcfc',
    value: '#fcfcfc',
    shadow: null,
    panel: null,
    padding: 0,
    // タイル 1 行ぶん。字形 7 px の下に 1 px 空くのが実機の BG 文字の見え方
    linePitch: 8,
  },
  SFC: {
    scale: 1,
    label: '#c0d0e8',
    value: '#f8f8f8',
    shadow: { offset: 1, color: '#181820' },
    panel: null,
    padding: 0,
    linePitch: 9,
  },
  PS1: {
    scale: 1,
    label: '#98b0c8',
    value: '#f0f4f8',
    shadow: null,
    panel: {
      // average は「背景と半分ずつ」しか出せないので、**空の色より十分暗く**しないと
      // パネルが背景に溶けて見えなくなる（実際に空の上で消えた）。
      // 不透明度で調整できる第4世代と違い、濃さは色でしか作れない
      color: '#0c1420',
      // 4 固定係数のうち average（0.5B + 0.5F）。任意の不透明度は出せない
      blend: { family: 'gen3-semitransparency', mode: 'average' },
    },
    padding: 3,
    linePitch: 9,
  },
  PS2: {
    scale: 2,
    label: '#9ab4d2',
    value: '#f8fafc',
    shadow: { offset: 1, color: '#101820' },
    panel: {
      color: '#162034',
      // GS の alpha blending。任意の不透明度を出せるのは 4 世代でこの世代だけ
      blend: { family: 'gen4-gs', preset: 'source-over', opacity: 0.62 },
    },
    padding: 4,
    linePitch: 9,
  },
});

/**
 * 世代の名札。**HUD にこれが出ていること**が、いま何世代目を見ているかの唯一の説明になる。
 * 切替演出中は 2 つが重なって見え、そのこと自体が切り替わっている印になる。
 *
 * 表記はハードウェア名ではなく**チャンネル番号**にする（実装計画 8-8）。
 * 番号が `1`〜`4` キーでの世代選択（8-7）とそのまま対応するので、
 * **テレビのチャンネルを回すと世代が変わる**という見立てが表示と操作で揃う。
 * 切替演出中はチャンネル番号が 2 つ同時に見え、「回している最中」として読める。
 */
export const GENERATION_LABELS: GenerationVariant<string> = defineGenerationVariant({
  FC: 'CH 1 : 1ST GEN',
  SFC: 'CH 2 : 2ND GEN',
  PS1: 'CH 3 : 3RD GEN',
  PS2: 'CH 4 : 4TH GEN',
});

/** m/s → km/h */
const KMH = 3.6;

export interface HudLine {
  readonly text: string;
  /** 真なら `value` 色。偽なら `label` 色（FC はどちらも同じ） */
  readonly emphasis: boolean;
}

export interface HudBlock {
  readonly id: string;
  readonly lines: readonly HudLine[];
  /** 字形の左上（タイル境界へ内側向きに丸め済み） */
  readonly left: number;
  readonly top: number;
  /** 字形の外形 [px]。パネルの寸法とテストの安全領域チェックが使う */
  readonly width: number;
  readonly height: number;
}

export interface HudView {
  readonly style: TextStyle;
  readonly blocks: readonly HudBlock[];
  /** パネル → 影 → 文字 の順に並んだスプライト。積む順がそのまま重ね順 */
  readonly sprites: readonly SpriteCommand[];
}

export interface HudOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  /**
   * 世代の更新レートへ量子化済みのスナップショット。
   * `RaceState` を直接渡すと**時計だけが 60Hz でなめらかに回り**、
   * 第1世代で車が 6Hz なのに数字がぬるぬる動く、という食い違いが出る
   */
  readonly display: DisplaySnapshot;
  /**
   * いま出ている画面。走行中の画面でなければ HUD は 1 つも積まない
   * （タイトルとリザルトはそれぞれの画面が自分の文字を出す）。
   * 省略時は常に出す — HUD 単体を検査するテストのため
   */
  readonly screen?: ScreenId;
  readonly layer?: number;
}

/** 「180 KM/H」。3 桁に右詰めして、数字が増減しても隣がずれないようにする */
function speedText(car: DisplayCar): string {
  return `${String(Math.round(car.speed * KMH)).padStart(3, ' ')} KM/H`;
}

/** 現在の周の経過時間。まだラインを越えていなければ未計測 */
function currentLapText(display: DisplaySnapshot, car: DisplayCar): string {
  if (car.lapStartTick < 0) return formatLapTime(-1);
  return formatLapTime(display.tick - car.lapStartTick);
}

/**
 * HUD が表示する 3 つの塊の中身。
 *
 * 世代に依るのは左上 1 行目の名札だけで、**残りは 4 世代で完全に同じ文字列**になる。
 * 見た目（色・拡大率・字送り・半透明）が変わっても、書いてある数字は
 * 1 つのシミュレーションから出た同じ値である — ミニマップと同じ主張の、文字版。
 *
 * 名札を左上へ置いてあるのは、**チャンネル表示はいちばん先に目に入る場所**に
 * あるべきだからで（8-8）、左下は速度 1 行だけになり、その左隣が
 * タコメーター（8-3・第3/第4世代のみ）の居場所になる。
 */
export function hudLines(
  display: DisplaySnapshot,
  generationLabel: string,
): { readonly id: string; readonly lines: readonly HudLine[] }[] {
  const player = display.cars[PLAYER_ENTRANT];
  if (!player) return [];
  return [
    {
      id: 'standing',
      lines: [
        // 「いま何チャンネルか」はシムが知らない唯一の表示。ビューが足す
        { text: generationLabel, emphasis: false },
        { text: `POS ${player.standing}/${ENTRANT_COUNT}`, emphasis: true },
        {
          text: `LAP ${Math.min(LAP_COUNT, Math.max(1, player.lap))}/${LAP_COUNT}`,
          emphasis: false,
        },
      ],
    },
    {
      id: 'laptime',
      lines: [
        // `TIME` と `BEST` を同じ字数にしてあるので、左揃えのままで桁が縦に揃う
        { text: `TIME ${currentLapText(display, player)}`, emphasis: true },
        { text: `BEST ${formatLapTime(player.bestLapTicks)}`, emphasis: false },
      ],
    },
    {
      id: 'speed',
      lines: [{ text: speedText(player), emphasis: true }],
    },
  ];
}

/**
 * HUD を組み立てる。フレームへは積まない（テストが純関数として検査できる）。
 */
export function buildHud(options: HudOptions): HudView {
  const { generation, profile, display } = options;
  const style = generationValue(TEXT_STYLES, generation);
  if (options.screen && !showsRaceHud(options.screen)) return { style, blocks: [], sprites: [] };
  const safe = safeAreaOf(profile);
  const scale = style.scale;
  const advance = fontAdvance(profile.video.tileSnap);
  const pitch = style.linePitch * scale;
  const glyphHeight = FONT_ATLAS.glyphHeight * scale;

  const content = hudLines(display, generationValue(GENERATION_LABELS, generation));

  const measure = (lines: readonly HudLine[]) => ({
    width: Math.max(0, ...lines.map((line) => measureText(line.text, scale, advance))),
    height: (lines.length - 1) * pitch + glyphHeight,
  });

  const blocks: HudBlock[] = [];
  for (const { id, lines } of content) {
    const { width, height } = measure(lines);
    // 縁へ寄せる方向へ丸める。四捨五入だと安全領域からはみ出すことがある
    const left =
      id === 'laptime'
        ? floorToTile(safe.left + safe.width - width, profile)
        : ceilToTile(safe.left, profile);
    const top =
      id === 'speed'
        ? floorToTile(safe.top + safe.height - height, profile)
        : ceilToTile(safe.top, profile);
    blocks.push({ id, lines, left, top, width, height });
  }

  const sprites: SpriteCommand[] = [];
  for (const block of blocks) {
    for (const sprite of blockSprites(block, options, style, pitch)) sprites.push(sprite);
  }

  return { style, blocks, sprites };
}

function blockSprites(
  block: HudBlock,
  options: HudOptions,
  style: TextStyle,
  pitch: number,
): SpriteCommand[] {
  const { generation, profile } = options;
  const layer = options.layer ?? 50;
  const sprites: SpriteCommand[] = [];

  // パネルは文字より先（＝奥）に積む。FC は panel が null なので何も積まれず、
  // `hardwareBlend` を持つコマンドが 1 つも生まれない（能力契約 `translucency: none`）
  if (style.panel) {
    const padding = style.padding * style.scale;
    sprites.push(
      panelSprite({
        id: `hud-panel-${generation}-${block.id}`,
        generation,
        rect: {
          left: block.left - padding,
          top: block.top - padding,
          width: block.width + padding * 2,
          height: block.height + padding * 2,
        },
        color: style.panel.color,
        layer: layer - 1,
        hardwareBlend: style.panel.blend,
      }),
    );
  }

  block.lines.forEach((line, index) => {
    for (const sprite of textSprites({
      id: `hud-${generation}-${block.id}-${index}`,
      text: line.text,
      generation,
      profile,
      x: block.left,
      y: block.top + index * pitch,
      color: line.emphasis ? style.value : style.label,
      scale: style.scale,
      shadow: style.shadow,
      layer,
    })) {
      sprites.push(sprite);
    }
  });

  return sprites;
}

/** 組み立てた結果をフレームへ積む。積んだ順がそのまま重ね順になる */
export function pushHud(frame: RenderFrame, options: HudOptions): HudView {
  const view = buildHud(options);
  for (const sprite of view.sprites) frame.sprites.push(sprite);
  return view;
}
