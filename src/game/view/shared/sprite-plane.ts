import {
  applyScanlineLimit,
  type Entity,
  type HardwareGenerationProfile,
  type RenderFrame,
  type SpriteCommand,
} from '@console-chaos/engine';

/**
 * スプライト面の組み立て（実装計画 §1.4 / §3.2 / §3.6）。擬似3D世代が共用する。
 *
 * 実機のスプライトには 2 つの決まりがあり、どちらも**エンジンは自動で守らない**。
 *
 * 1. **走査線あたりの上限**（FC は 8・SFC は 32）。超えた分は消える。
 *    `applyScanlineLimit` は登録順に受け付けるので、**消えてほしくないものを先に登録する**。
 * 2. **重なりは接地線の Y で決まる**（実装計画 11-2 / R-2）。画面の下にある物ほど
 *    手前に居るので、**接地線 Y の昇順に積む**（エンジンは後に積んだものを手前に描く）。
 *    以前は「登録順の逆」に積んでいたが、`rivalPlacements()` が遠い順に返すため
 *    **遠い車が手前に出ていた**（FC で 7.5 %・SFC で 16.0 % のフレーム）。
 *    自機も同じ 1 本の並びに入るので、自機より手前のライバルが自機の後ろに
 *    隠れることも無くなる。
 *
 * **走査線制限のほうは従来どおり登録順で掛ける。** 制限の優先度（何を消すか）と
 * 重なり（何が手前か）は別の問いで、前者は「自機を必ず残す」ことが要る。
 *
 * 枠や HUD の文字は実機では BG タイル面に描かれ、スプライト枠を消費しなかった。
 * `background` / `foreground` はその扱い — どちらも制限の対象外で、
 * 前者は最背面、後者は最前面に積む。実機の BG 面もスプライトの前後どちらにも置けた
 * （優先度ビット）ので、ミニマップの枠は背面・HUD の文字は前面、という分け方になる。
 */

export interface SpriteEntry {
  /** 走査線制限で落ちたときに記録される識別子。当たり判定を持たないものは `NO_ENTITY` */
  readonly entity: Entity;
  /** 絵のある範囲の上端 [px] */
  readonly y: number;
  /** 絵のある範囲の高さ [px] */
  readonly height: number;
  /** この 1 件を構成するスプライト（影・縁を含む）。落ちるときはまとめて落ちる */
  readonly sprites: readonly SpriteCommand[];
  /**
   * 接地線 Y の順に積む対象か。既定は真。
   *
   * 偽にするのは**奥行きを持たない記号**だけ — ミニマップのマーカーは画面に
   * 貼られた図であって世界に居る物ではないので、車と重ね順を競わせない。
   * 偽の物は登録順のまま、Y 順の群より手前に積む。
   */
  readonly depthSorted?: boolean;
}

export interface SpritePlaneOptions {
  readonly profile: HardwareGenerationProfile;
  /** 登録順＝優先度。自機を必ず先頭に置く */
  readonly entries: readonly SpriteEntry[];
  /** BG 相当。制限の対象外で最背面に積む */
  readonly background?: readonly SpriteCommand[];
  /** BG 相当（優先度つき）。制限の対象外で最前面に積む。HUD の文字がこれ */
  readonly foreground?: readonly SpriteCommand[];
}

/** 走査線制限を適用してフレームへ積む。戻り値は制限で落ちたエントラント */
export function pushSpritePlane(
  frame: RenderFrame,
  options: SpritePlaneOptions,
): readonly Entity[] {
  const { profile, entries } = options;
  const limited = applyScanlineLimit(
    entries,
    profile.video.spritesPerScanline,
    profile.video.internalHeight,
  );

  for (const sprite of options.background ?? []) frame.sprites.push(sprite);

  // 接地線（`y + height`）で比べる。中心や上端で比べると、大きさの違う 2 台が
  // 同じ地面に居るときに前後が入れ替わる。同じ接地線なら登録順を保つ（安定ソート）
  const grounded = limited.visible.filter((entry) => entry.depthSorted !== false);
  grounded.sort((left, right) => left.y + left.height - (right.y + right.height));
  for (const entry of grounded) {
    for (const sprite of entry.sprites) frame.sprites.push(sprite);
  }

  // 奥行きを持たない記号は登録順のまま手前へ
  for (const entry of limited.visible) {
    if (entry.depthSorted !== false) continue;
    for (const sprite of entry.sprites) frame.sprites.push(sprite);
  }

  for (const sprite of options.foreground ?? []) frame.sprites.push(sprite);

  return limited.culled;
}
