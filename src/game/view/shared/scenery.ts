import type { Track } from '../../sim/track.js';

/**
 * 背景オブジェクトの配置（実装計画 8-6）。
 *
 * **4 世代がこの 1 つの表を読む。** ミニマップと同じ主張の背景版で、
 * 同じ場所に同じ看板が立っていることが「1 つの世界を 4 通りに描いている」ことの
 * もう 1 つの証拠になる。
 *
 * 配置は**乱数を使わない**。`s` と `curvature` だけから決まるので、
 * 生成ツール（コースメッシュへ焼く壁やタイヤフェンス）と実行時が必ず一致する。
 *
 * 世代ごとに出す物は違う（FC は看板だけ、PS2 は木もフェンスも）が、
 * **出す物の場所は 4 世代で完全に同じ**であり、`scenery.spec.ts` がそれを固定する。
 */

export type SceneryKind = 'sign' | 'tree' | 'tyres';

export interface SceneryObject {
  /** 決定論的な通し番号（`s` の昇順）。スプライト id に使う */
  readonly id: number;
  readonly kind: SceneryKind;
  /** 弧長 [m] */
  readonly s: number;
  /** 中心線からの右向き距離 [m]。負が左 */
  readonly lateral: number;
  /** 高さ [m]。3D 世代のビルボードの寸法になる */
  readonly height: number;
}

/** ここを超える曲率を「コーナー」とみなす [1/m]（8-1 のステアフレームと同じ基準） */
const CORNER_CURVATURE = 1 / 240;
/** ここを超えると「高曲率区間」＝ タイヤフェンスを置く [1/m] */
const TIGHT_CURVATURE = 1 / 90;

/** 看板をコーナー入口の何 m 手前に立てるか */
const SIGN_LEAD = 30;
/** 看板どうしの最小間隔 [m]。閾値の際で曲率が揺れても看板が並ばない */
const SIGN_MIN_GAP = 120;
/** 木・タイヤフェンスの間隔 [m] */
const TREE_SPACING = 25;
const TYRE_SPACING = 12;

/**
 * 路面の縁からどれだけ外へ置くか [m]。
 *
 * 木だけは**壁の外**に立てる（実画面で確認）。3D 世代のコースメッシュは
 * 路面の外へ縁石 1.2 m ＋ 草地 9 m を張り、その外縁に高さ 1 m の壁が立つので、
 * 木を 13 m に置くと壁の内側 ＝ コースの敷地の中に生えてしまう。
 * 看板とタイヤフェンスは壁の内側でよい（実際のサーキットでもそこにある）。
 */
const OFFSET = { sign: 5, tree: 20, tyres: 3 } as const;

/** 高さ [m]。擬似3D 世代のスプライトの大きさもここから決まる */
const HEIGHT = { sign: 3.2, tree: 7, tyres: 1.1 } as const;

/** コーナーの外側はどちら向きか。曲率は左が正なので、左コーナーの外側は右 */
function outsideSign(curvature: number): number {
  return curvature > 0 ? 1 : -1;
}

/**
 * コース全周の背景オブジェクト。`s` の昇順で返す。
 *
 * - コーナー入口の 30 m 手前 … 看板（外側）
 * - 高曲率区間 … タイヤフェンス（外側・12 m 間隔）
 * - それ以外 … 木（左右・25 m 間隔）
 */
export function sceneryObjects(track: Track): readonly SceneryObject[] {
  const objects: { kind: SceneryKind; s: number; lateral: number; height: number }[] = [];
  const wrap = (s: number) => track.wrapS(s);

  // ── 看板。曲率がコーナーの閾値を跨いだ最初のサンプルが「入口」。
  // 閾値の際で曲率が揺れると入口が何度も立つので、**最小間隔**を置いて間引く
  const samples = track.samples;
  let lastSignS = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index]!;
    const previous = samples[(index - 1 + samples.length) % samples.length]!;
    const entering =
      Math.abs(sample.curvature) >= CORNER_CURVATURE &&
      Math.abs(previous.curvature) < CORNER_CURVATURE;
    if (!entering) continue;
    if (sample.s - lastSignS < SIGN_MIN_GAP) continue;
    lastSignS = sample.s;

    const s = wrap(sample.s - SIGN_LEAD);
    const at = track.sampleAt(s);
    objects.push({
      kind: 'sign',
      s,
      lateral: outsideSign(sample.curvature) * (at.halfWidth + OFFSET.sign),
      height: HEIGHT.sign,
    });
  }

  // ── タイヤフェンス。高曲率区間の外側だけに、等間隔で
  for (let s = 0; s < track.length; s += TYRE_SPACING) {
    const sample = track.sampleAt(s);
    if (Math.abs(sample.curvature) < TIGHT_CURVATURE) continue;
    objects.push({
      kind: 'tyres',
      s,
      lateral: outsideSign(sample.curvature) * (sample.halfWidth + OFFSET.tyres),
      height: HEIGHT.tyres,
    });
  }

  // ── 木。タイヤフェンスを置いた区間には置かない（近すぎて重なる）
  for (let s = 0; s < track.length; s += TREE_SPACING) {
    const sample = track.sampleAt(s);
    if (Math.abs(sample.curvature) >= TIGHT_CURVATURE) continue;
    for (const side of [-1, 1]) {
      objects.push({
        kind: 'tree',
        s,
        lateral: side * (sample.halfWidth + OFFSET.tree),
        height: HEIGHT.tree,
      });
    }
  }

  // `s` の昇順に並べ、同じ `s` では左から。**並びが決まっていること**が
  // 「4 世代で同じ id が同じ物を指す」ための条件になる
  objects.sort((left, right) => left.s - right.s || left.lateral - right.lateral);
  return objects.map((object, id) => ({ id, ...object }));
}

/**
 * コースごとに 1 度だけ組み立てて使い回す。
 *
 * 中身は `s` と `curvature` だけから決まる純粋な結果なので、
 * 使い回しても「ビューは状態を持たない」（§2.1）に反しない — 同じコースなら
 * 何度呼んでも同じ配列になる。毎フレーム 262 個を組み直す必要が無いだけ。
 */
const cache = new WeakMap<Track, readonly SceneryObject[]>();

export function sceneryFor(track: Track): readonly SceneryObject[] {
  const cached = cache.get(track);
  if (cached) return cached;
  const objects = sceneryObjects(track);
  cache.set(track, objects);
  return objects;
}

/** 種類ごとの絞り込み。世代が「出す物」を選ぶのに使う */
export function sceneryOfKinds(
  objects: readonly SceneryObject[],
  kinds: readonly SceneryKind[],
): readonly SceneryObject[] {
  return objects.filter((object) => kinds.includes(object.kind));
}
