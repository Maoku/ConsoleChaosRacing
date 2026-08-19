import type { Track } from './track.js';
import { insideTunnel } from './tunnel.js';

/**
 * 壁の材質（実装計画 11-4 / R-4 / D-8・D-10）。
 *
 * コースの外周に立っているのはコンクリートの擁壁だが、**高曲率区間だけは
 * その内側にタイヤバリアが貼られている**（実際のサーキットと同じ作りで、
 * `scenery.ts` がその区間にタイヤフェンスを立てている）。
 *
 * どこがタイヤかを決める規則は**この 1 つ**で、`sceneryObjects()` の
 * タイヤフェンスの配置もここから引く。**見えているタイヤ壁と当たり判定が
 * 構造的にずれない**のはそのためである。
 *
 * 置き場所が `vehicle.ts` でも `scenery.ts` でもないのは、
 * どちらからも読むから — `vehicle.ts → scenery.ts → vehicle.ts` の
 * 循環 import を作らないために、共通の規則だけをここへ出してある。
 */

export type WallMaterial = 'concrete' | 'tyre';

/** ここを超えると「高曲率区間」＝ タイヤバリアを貼る [1/m] */
export const TIGHT_CURVATURE = 1 / 90;

/** コーナーの外側はどちら向きか。曲率は左が正なので、左コーナーの外側は右 */
export function outsideSign(curvature: number): -1 | 1 {
  return curvature > 0 ? 1 : -1;
}

/**
 * 材質ごとの当たりの強さ（D-10）。
 *
 * - `bite` — 外向きの横速度 1 m/s あたり削る速度 [m/s]。**激突の効き**
 * - `minimumLoss` — 触れたら必ず失う速度の割合。**掠りの下限**で、
 *   これが無いと壁を舐めながら走るのがいちばん速いラインになる
 * - `bounce` — 壁から内側へ戻す量 [m]。貼り付いたままにしない
 *
 * コンクリートは硬く弾き、タイヤは深く沈んでよく殺す。
 */
export const WALL = {
  concrete: { bite: 1.8, minimumLoss: 0.08, bounce: 0.4 },
  tyre: { bite: 3.0, minimumLoss: 0.14, bounce: 0.8 },
} as const satisfies Record<
  WallMaterial,
  { readonly bite: number; readonly minimumLoss: number; readonly bounce: number }
>;

/**
 * その弧長・その側の壁の材質。
 *
 * タイヤバリアが貼られているのは**高曲率区間の外側だけ**である。内側は
 * コンクリートのまま — 実際のサーキットでもバリアを貼るのは飛び出す側だけで、
 * `scenery.ts` がタイヤフェンスを立てるのもその側だけである。
 */
export function wallMaterialAt(track: Track, s: number, side: -1 | 1): WallMaterial {
  const sample = track.sampleAt(s);
  if (Math.abs(sample.curvature) < TIGHT_CURVATURE) return 'concrete';
  if (outsideSign(sample.curvature) !== side) return 'concrete';
  // トンネルの中には何も置かない（8-9）。壁は躯体そのものなのでコンクリート
  if (insideTunnel(track, s)) return 'concrete';
  return 'tyre';
}
