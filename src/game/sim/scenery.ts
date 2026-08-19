import type { Track } from './track.js';
import { insideTunnel } from './tunnel.js';
import { wallLateral } from './vehicle.js';
import { TIGHT_CURVATURE, outsideSign } from './wall.js';

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
 *
 * **置き場所が `sim/` なのは、シムが view を import しないため**である（不変条件）。
 * 壁の材質はここに立っている物から決まる（11-4）ので、配置表はシム側の真実になる。
 * 配置は `s` と `curvature` だけから決まる決定論的な表で、もともと
 * 「4 世代 ＋ 生成ツールが読む 1 つの真実」だった。
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
 * 路面の外へ縁石 1.2 m ＋ 草地 7.8 m を張り、その外縁に高さ 1 m の壁が立つので、
 * 木を 13 m に置くと壁の内側 ＝ コースの敷地の中に生えてしまう。
 * 看板は壁の内側でよい（実際のサーキットでもそこにある）。
 *
 * **タイヤフェンスはここに無い。** 壁の内貼りなので位置は `wallLateral()` から
 * 引く（実装計画 D-8）。縁から 3 m のまま当たり判定を足すと、その外側（3〜15 m）へ
 * 出た車が戻れなくなり、9-1 の「戻れない地点は 1 つも無い」を壊す。
 */
const OFFSET = { sign: 5, tree: 20 } as const;

/** 高さ [m]。スプライトもビルボードもこの値を世界での寸法として使う */
const HEIGHT = { sign: 3.2, tree: 7, tyres: 1.1 } as const;

/**
 * 木の背丈 [m]（実装計画 8-10）。
 *
 * **全部同じ背丈だと並木が「同じ絵の反復」に見える**（実画面でいちばん目立った粗さ）。
 * 乱数は使わず、`s` の刻み番号と左右から決まる 4 周期の表を引く。
 * 第4世代は絵のほうも 3 種類あるので、見かけの周期は 12 本ぶんに伸びる。
 */
const TREE_HEIGHTS = [7.6, 6.4, 8.2, 6.9] as const;

/**
 * コース全周の背景オブジェクト。`s` の昇順で返す。
 *
 * - コーナー入口の 30 m 手前 … 看板（外側）
 * - 高曲率区間 … タイヤフェンス（外側・12 m 間隔・**壁の内貼り**）
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

  // ── タイヤフェンス。高曲率区間の外側だけに、等間隔で。
  // **壁の位置に貼る**（D-8）ので、区間と側の決め方は `wallMaterialAt()` と同じ 1 つの規則
  for (let s = 0; s < track.length; s += TYRE_SPACING) {
    const sample = track.sampleAt(s);
    if (Math.abs(sample.curvature) < TIGHT_CURVATURE) continue;
    objects.push({
      kind: 'tyres',
      s,
      lateral: outsideSign(sample.curvature) * wallLateral(sample.halfWidth),
      height: HEIGHT.tyres,
    });
  }

  // ── 木。タイヤフェンスを置いた区間には置かない（近すぎて重なる）
  for (let step = 0; step * TREE_SPACING < track.length; step++) {
    const s = step * TREE_SPACING;
    const sample = track.sampleAt(s);
    if (Math.abs(sample.curvature) >= TIGHT_CURVATURE) continue;
    for (const [index, side] of [-1, 1].entries()) {
      objects.push({
        kind: 'tree',
        s,
        lateral: side * (sample.halfWidth + OFFSET.tree),
        height: TREE_HEIGHTS[(step * 2 + index) % TREE_HEIGHTS.length] ?? HEIGHT.tree,
      });
    }
  }

  // `s` の昇順に並べ、同じ `s` では左から。**並びが決まっていること**が
  // 「4 世代で同じ id が同じ物を指す」ための条件になる
  objects.sort((left, right) => left.s - right.s || left.lateral - right.lateral);
  // トンネルの中には何も置かない（8-9）。中からは内壁で見えず、外からは坑口の
  // 外に立つので、置いても得が無い。**間引くのは 4 世代とも同じ**なので、
  // 「同じ物が同じ場所にある」という 8-6 の主張は保たれる
  return objects
    .filter((object) => !insideTunnel(track, object.s))
    .map((object, id) => ({ id, ...object }));
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
