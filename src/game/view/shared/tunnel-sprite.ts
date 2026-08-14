import {
  defineGenerationVariant,
  generationValue,
  type GenerationId,
  type GenerationVariant,
  type HardwareGenerationProfile,
  type SpriteCommand,
} from '@console-chaos/engine';

import type { Track } from '../../sim/track.js';
import { MARKER_ATLAS } from './minimap-layout.js';
import type { RoadView } from './projection.js';
import { TUNNEL, tunnelHalfWidth, tunnelSpanAhead } from './tunnel.js';

/**
 * 擬似3D世代のトンネル（実装計画 8-9）。
 *
 * **メッシュは 1 つも積まない。** 第1・第2世代が持っているのは走査線と
 * スプライトだけなので、トンネルもその 2 つだけで出す。
 *
 * 1. **路面が暗くなる** — トンネルの中に当たる走査線を落とす。
 *    第1世代は `RasterSurfaceCommand` の `brightness`（実機の走査線ごとの
 *    パレット差し替えに対応する）、第2世代は color math の subtract 帯。
 * 2. **坑口** — 穴の開いた壁を不透明の矩形 3 枚で作る。
 *
 * ## 矩形 3 枚が外からも中からも同じ式になる理由
 *
 * 外に居るときの「入口の妻壁」と、中に居るときの「出口の手前の内壁」は、
 * どちらも**画面の上端から路面のある行までを覆い、坑口のぶんだけ穴が開いた壁**である。
 * 違うのは
 *
 * - 壁までの距離（外なら入口まで、中なら出口まで）
 * - 壁の色（外はコンクリート、中は暗いトンネルの内側）
 *
 * の 2 つだけなので、1 本の式で両方が出る。近づけば穴が広がり、くぐった瞬間に
 * 「入口の妻壁」から「内壁」へ入れ替わって、出口の穴が遠くに小さく開く。
 *
 * 3D の 2 世代とは**同じ表（`tunnel.ts`）の同じ区間**を見ているので、
 * トンネルの位置も長さも 4 世代で完全に一致する。
 */

/**
 * 坑口の妻壁（外から見える面）と、内壁（中から見える面）の色。
 *
 * **世代ごとに持つ。** 第1世代の 54 色マスターパレットには
 * `#000000` と `#545454` のあいだに無彩色が 1 つも無く、暗い灰は
 * すべて有彩色の枠へ落ちる（`#202020` は暗い緑 `#202a00` になった。実画面で確認）。
 * 出せない色を書いても意味が無いので、第1世代の内壁は**黒そのもの**にする。
 * 第2世代は RGB555 の格子（各チャンネル 8 の倍数）から、影のコンクリートの色を採る。
 */
const TUNNEL_COLORS: GenerationVariant<{ facade: string; interior: string }> =
  defineGenerationVariant({
    FC: { facade: '#8c8c8c', interior: '#000000' },
    SFC: { facade: '#909088', interior: '#101018' },
    // 3D の 2 世代は焼いたメッシュで出すので、この表は引かない
    PS1: { facade: '#8c8c8c', interior: '#101018' },
    PS2: { facade: '#8c8c8c', interior: '#101018' },
  });

/**
 * 第1世代の路面をどれだけ暗くするか（走査線の `brightness`）。
 *
 * **この値は 54 色マスターパレットから逆算してある。** レンダラーの量子化は
 * 輝度重み付きの距離（`dr²·0.299 + dg²·0.587 + db²·0.114`）で最近傍を採るので、
 * 舗装 `#545454` を暗くしていくと落ち先は 3 つしか無い。
 *
 * | 明るさ | 舗装 | 白線 | 縁石 | 草地 |
 * | --- | --- | --- | --- | --- |
 * | ≥ 0.6875 | `#545454`（変わらない） | `#989698` | `#540400` | `#004000` |
 * | 0.25–0.625 | `#202a00`（暗い緑） | `#989698` | `#3c1800` | `#083a00` |
 * | ≤ 0.1875 | `#000000` | `#202a00` | `#000000` | `#000000` |
 *
 * **このパレットに暗い無彩色は 1 つも無い。** 中間を採ると路面が草地の色になり、
 * 「暗い舗装」ではなく「芝生の上を走っている」ように見える（実画面で確認）。
 * そこで**黒へ落としきる** 3/16 を採る。舗装・縁石・草地がすべて黒へ落ち、
 * 路肩の白線とセンターラインだけが `#202a00` で残るので、
 * **暗闇にラインだけが浮かぶ**という当時のトンネルそのものの絵になる。
 *
 * 奥行きの階調も走査線の縞もトンネルの中では**掛けない**。掛けると行ごとに
 * 落ち先が黒と緑のあいだで揺れて、路面が縞に割れる。実機のトンネルも
 * パレットを丸ごと差し替えるものであって、行ごとに濃淡を作るものではない。
 */
export const TUNNEL_ROAD_SHADE = 3 / 16;

/** スプライトの層。フォグの帯（10）より奥、遠景の層より手前 */
const LAYER = 8;

export interface TunnelScreenOptions {
  readonly generation: GenerationId;
  readonly profile: HardwareGenerationProfile;
  readonly track: Track;
  readonly view: RoadView;
}

export interface TunnelScreen {
  /** 視点がトンネルの中か */
  readonly inside: boolean;
  /** 坑口の妻壁／内壁（不透明・BG 相当）。手前から見て奥に置く */
  readonly panels: readonly SpriteCommand[];
  /**
   * 背景オブジェクトを描く上限距離 [m]。
   *
   * **坑口の壁の向こうにある物は見えない。** 壁は BG 相当のスプライトなので、
   * 木をそのまま積むと**壁の上に木が生える**（実画面で確認）。木もタイヤフェンスも
   * トンネルの外側（路面の縁から 20 m）に立っていて、坑口の穴には決して重ならないので、
   * 手前の坑口までで切ってしまってよい。**車は切らない** — 車は路面の上、
   * すなわちトンネルの内空の中に居るので、穴を通してそのまま見える。
   */
  readonly sceneryClip: number;
  /** その画面行がトンネルの中を映しているか */
  shadedRow(row: number): boolean;
}

/** 何も無いときの答え。呼び出し側が毎回 null を書き分けなくてよいように */
const NOTHING: TunnelScreen = {
  inside: false,
  panels: [],
  sceneryClip: Number.POSITIVE_INFINITY,
  shadedRow: () => false,
};

export function tunnelScreen(options: TunnelScreenOptions): TunnelScreen {
  const { generation, profile, track, view } = options;
  const { near, far } = tunnelSpanAhead(track, view.originS);
  const inside = near <= 0;
  const farClip = view.maxDistance;

  // まだ視界に入っていない
  if (!inside && near > farClip) return NOTHING;

  const snap = Math.max(1, profile.video.tileSnap);
  const round = (value: number) => Math.round(value / snap) * snap;

  // 壁までの距離。外なら入口、中なら出口
  const portal = inside ? far : near;
  const panels: SpriteCommand[] = [];
  const palette = generationValue(TUNNEL_COLORS, generation);
  const color = inside ? palette.interior : palette.facade;

  const rect = (
    index: number,
    left: number,
    top: number,
    right: number,
    bottom: number,
    fill = color,
  ) => {
    const clampedLeft = Math.max(0, Math.min(view.screenWidth, left));
    const clampedRight = Math.max(0, Math.min(view.screenWidth, right));
    const clampedTop = Math.max(0, top);
    const width = round(clampedRight) - round(clampedLeft);
    const height = round(bottom) - round(clampedTop);
    if (width <= 0 || height <= 0) return;
    panels.push({
      id: `tunnel-${generation}-${index}`,
      screenSpace: true,
      position: [round(clampedLeft) + width / 2, round(clampedTop) + height / 2, 0],
      size: [width, height],
      color: fill,
      texture: MARKER_ATLAS.url,
      cell: MARKER_ATLAS.cells.fill,
      // 半透明は 1 つも使わない（第1世代の能力契約）。壁は不透明の板そのもの
      layer: LAYER,
      generations: [generation],
    });
  };

  const wallBottom = Math.min(view.screenHeight, view.rowAtDistance(Math.max(portal, 0.5)));
  if (portal > farClip) {
    // 出口が描画距離の外。奥まで内壁しか無いので、穴の無い 1 枚で覆う
    rect(0, 0, 0, view.screenWidth, view.rowAtDistance(farClip));
  } else {
    const scale = view.scaleAt(portal);
    const inner = tunnelHalfWidth(track, track.wrapS(view.originS + portal));
    const half = inner * scale;
    const centerX = view.centerXAt(portal);
    const openingTop = wallBottom - TUNNEL.crownHeight * scale;

    /**
     * 壁の外周。**外に居るときは坑口の躯体そのものの大きさ**にする。
     * 画面の端まで伸ばすと「世界を横切る壁」になり、40 m 手前でも空が
     * 1 画素も見えなくなる（実画面で確認）。3D の 2 世代が焼いている外殻と
     * 同じ `portalScale` を掛けるので、4 世代で坑口の見かけの大きさが揃う。
     * 中に居るときは逆に、内壁が視界を覆いきるのが正しい。
     */
    const outerLeft = inside ? 0 : centerX - inner * TUNNEL.portalScale * scale;
    const outerRight = inside ? view.screenWidth : centerX + inner * TUNNEL.portalScale * scale;
    const outerTop = inside
      ? 0
      : wallBottom - TUNNEL.crownHeight * TUNNEL.portalScale * scale;

    rect(0, outerLeft, outerTop, outerRight, openingTop);
    rect(1, outerLeft, openingTop, centerX - half, wallBottom);
    rect(2, centerX + half, openingTop, outerRight, wallBottom);

    /**
     * 坑口の穴の奥。**外に居るときだけ**要る。
     *
     * 穴の中で路面が描かれるのは路面帯の上端（`roadTopRow`）から下だけなので、
     * それより上の帯には遠景がそのまま覗いてしまう —— 坑口の向こうに海と山が
     * 見えることになる（実画面で確認）。そこを内壁の色で塞ぐ。
     * 路面の帯には掛からないので、中の路面は走査線／color math の暗さがそのまま残る。
     */
    if (!inside) {
      rect(
        3,
        centerX - half,
        openingTop,
        centerX + half,
        Math.min(wallBottom, view.camera.roadTopRow),
        palette.interior,
      );
    }
  }

  /**
   * その行が映しているのがトンネルの中か。行 → 距離は投影の逆関数そのもので、
   * **路面の明るさを決める式と坑口の位置がずれない**（どちらも同じ `RoadView` を通る）。
   */
  const shadedRow = (row: number): boolean => {
    const distance = view.distanceAtRow(row);
    if (!Number.isFinite(distance)) return inside;
    return distance >= near && distance <= far;
  };

  return { inside, panels, sceneryClip: portal, shadedRow };
}
