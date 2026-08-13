/**
 * HUD のビットマップフォントとタイトルロゴのアトラス（実装計画 §3.5 / §3.7）。
 *
 * `OverlayCommand`（text / rect）は **Canvas 2D レンダラーでしか描かれない**。
 * `createGenerationWebGlRenderer` は overlays を丸ごと無視するので、
 * 文字はスクリーン空間スプライトと自前のフォントアトラスで出すしかない。
 * エンジン 0.2.0 でスプライトが 4 世代すべてに描かれるようになったため、
 * HUD は**世代分岐のない 1 つの経路**で組める。
 *
 * **このファイルはゲーム本体と `tools/build-font-atlas.mjs` /
 * `tools/build-title-logo.mjs` の両方から import される。**
 * 字形そのもの（`tools/lib/glyphs.mjs`）は生成側にしか無いが、
 * セルの寸法と字送りはここが唯一の出どころなので、
 * 焼いた絵と実行時の配置がずれる余地が構造的に無い（ミニマップと同じ作り）。
 */

/**
 * フォントアトラス。ASCII 0x20–0x7F の 96 文字を 16 列 × 6 行に並べる。
 *
 * 字形は 5×7 でセルの**左上**に置く。セルの余りの 3 列 / 1 行は透明なので、
 * 字送り（`advance`）をセルの一辺より狭く採っても隣の字を消さない
 * （スプライトは `alphaCutoff` で透明画素を捨てる）。
 *
 * 小文字のセルには**大文字と同じ字形**が焼いてある。当時の HUD フォントの作法であり、
 * 実行時に大文字へ畳む処理を持たなくて済む。
 */
export const FONT_ATLAS = {
  url: 'assets/common/font.png',
  columns: 16,
  rows: 6,
  /** 1 セルの一辺 [px] */
  cell: 8,
  /** セル 0 に対応する文字コード（空白） */
  firstCharCode: 0x20,
  /** 字形の幅 [px] */
  glyphWidth: 5,
  /** 字形の高さ [px] */
  glyphHeight: 7,
  /** 字送り [px]。字形 5 px ＋ 隙間 1 px */
  advance: 6,
} as const;

/**
 * タイトルロゴ（`tools/build-title-logo.mjs`）。
 *
 * **1 枚で 4 世代ぶんを賄う。** FC では 54 色パレットへ、SFC では RGB555 へ
 * レンダラーが自動で量子化するので、世代ごとに焼き分ける必要が無い（§3.7）。
 * 配置と拡大率だけをビュー側の variant テーブルで変える。
 *
 * スプライトはアトラス経由でしか描けないので、1 セルのアトラスとして登録する。
 */
export const LOGO_ATLAS = {
  url: 'assets/common/logo.png',
  columns: 1,
  rows: 1,
  width: 256,
  height: 64,
} as const;

/**
 * 0x7F（DEL）のセルには**セルいっぱいの塗りつぶし**が焼いてある。
 *
 * 単色の矩形（HUD とタイトルのパネル）を出すのにフォントアトラス 1 枚で足り、
 * ミニマップのマーカーアトラスへ切り替えなくて済む。
 *
 * ほかのセルと違って 5×7 ではなく 8×8 を埋めるのは、引き伸ばして矩形にするため。
 * 字形と同じ大きさで焼くと、パネルが指定した寸法の 5/8 × 7/8 にしか広がらない
 * （実画面で右と下が欠けた）。`font-atlas.spec.ts` がこのセルだけを例外として固定する。
 */
export const FILL_CHAR_CODE = 0x7f;

/** アトラス内のセル番号。範囲外の文字は `null`（描かない） */
export function fontCell(charCode: number): number | null {
  const cell = charCode - FONT_ATLAS.firstCharCode;
  if (cell < 0 || cell >= FONT_ATLAS.columns * FONT_ATLAS.rows) return null;
  return cell;
}

/**
 * その世代の字送り [px]（拡大前）。
 *
 * **タイル境界を持つ世代（FC）では 8 px** になる。実機の HUD 文字は BG タイル面に
 * 描かれ、1 文字が 1 タイルを占めていたので、字間がタイルの一辺そのものだった。
 * 以降の世代は字形の幅どおりに詰まる。世代 ID を見ずに `tileSnap` から導けるので、
 * この 1 行が FC と SFC の HUD の見た目の差をそのまま作る（能力契約 §1.4）。
 */
export function fontAdvance(tileSnap: number): number {
  return Number.isFinite(tileSnap) && tileSnap > FONT_ATLAS.advance ? tileSnap : FONT_ATLAS.advance;
}

/** 文字列の描画幅 [px]。最後の 1 文字ぶんの隙間は含めない */
export function measureText(text: string, scale = 1, advance: number = FONT_ATLAS.advance): number {
  if (text.length === 0) return 0;
  return (text.length * advance - (advance - FONT_ATLAS.glyphWidth)) * scale;
}

/** 文字列の描画高さ [px]。セルではなく**字形**の高さ（行間はビュー側が決める） */
export function textHeight(scale = 1): number {
  return FONT_ATLAS.glyphHeight * scale;
}
