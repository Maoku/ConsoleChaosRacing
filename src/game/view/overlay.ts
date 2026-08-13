import { generationValue, type RenderFrame, type SpriteCommand } from '@console-chaos/engine';

import { formatLapTime } from '../sim/race.js';
import { COUNTDOWN_TICKS, LAP_COUNT } from '../sim/state.js';
import type { ViewContext } from './context.js';
import { centeredBlock } from './shared/centered-text.js';
import type { DisplayCar } from './shared/display-state.js';
import { TEXT_STYLES } from './shared/hud.js';
import { floorToTile } from './shared/quantize.js';
import { titleSprites } from './title.js';
import { PLAYER_ENTRANT } from './shared/variants.js';

/**
 * 画面の上に載る文字（実装計画 §5.2 / §3.7）。
 *
 * タイトル・カウントダウン・ゴール・ポーズ・リザルトを 1 か所で振り分ける。
 * **4 世代とも同じ組み立て**で、世代差は `TEXT_STYLES` の 1 つの表から来る。
 *
 * `view/index.ts` が各世代のビューの**後**に呼ぶので、
 * ここで積んだスプライトは必ず最前面になる。第1世代でも走査線制限の対象外で、
 * 実機の BG タイル面に相当する扱いになっている（§3.6 と同じ根拠）。
 */

/** 「GO!」を racing へ入ってから何 tick 出し続けるか */
const GO_TICKS = 60;
/** ゴール直後の「FINISH」 */
const FINISH_TICKS = 180;

/** カウントダウンの縦位置（画面高に対する割合）。車に被らない高さ */
const COUNTDOWN_TOP = 0.28;
const RESULT_TOP = 0.2;
const CENTER_TOP = 0.38;

function carName(car: DisplayCar): string {
  return car.entrant === PLAYER_ENTRANT ? 'YOU' : `CAR ${car.entrant + 1}`;
}

/**
 * カウントダウンの表示。
 *
 * 残り tick を秒へ切り上げると 4 → 1 と減るので、1 つずらして 3・2・1 にする。
 * 残り 1 秒の区間が「GO!」で、そのまま racing の頭 1 秒まで出し続ける。
 * `sfx.ts` のシグナル音も同じ境目で鳴るので、音と絵がずれない。
 */
function countdownText(countdownTicks: number): string {
  const remaining = Math.ceil(countdownTicks / 60);
  return remaining >= 2 ? String(remaining - 1) : 'GO!';
}

function countdownSprites(context: ViewContext): readonly SpriteCommand[] {
  const { profile, display } = context;
  const style = generationValue(TEXT_STYLES, context.generation);
  return centeredBlock({
    id: 'countdown',
    context,
    style,
    top: floorToTile(profile.video.internalHeight * COUNTDOWN_TOP, profile),
    lines: [{ text: countdownText(display.countdown), scale: 5 }],
  }).sprites;
}

function goSprites(context: ViewContext): readonly SpriteCommand[] {
  const style = generationValue(TEXT_STYLES, context.generation);
  return centeredBlock({
    id: 'go',
    context,
    style,
    top: floorToTile(context.profile.video.internalHeight * COUNTDOWN_TOP, context.profile),
    lines: [{ text: 'GO!', scale: 5 }],
  }).sprites;
}

function finishSprites(context: ViewContext): readonly SpriteCommand[] {
  const { profile, display } = context;
  const style = generationValue(TEXT_STYLES, context.generation);
  const player = display.cars[PLAYER_ENTRANT];
  return centeredBlock({
    id: 'finish',
    context,
    style,
    panel: true,
    top: floorToTile(profile.video.internalHeight * CENTER_TOP, profile),
    lines: [
      { text: 'FINISH', scale: 3 },
      { text: `POSITION ${player?.standing ?? 1}`, scale: 1, emphasis: false, gapBefore: 6 },
    ],
  }).sprites;
}

function pausedSprites(context: ViewContext): readonly SpriteCommand[] {
  const style = generationValue(TEXT_STYLES, context.generation);
  return centeredBlock({
    id: 'paused',
    context,
    style,
    panel: true,
    top: floorToTile(context.profile.video.internalHeight * CENTER_TOP, context.profile),
    lines: [
      { text: 'PAUSED', scale: 3 },
      { text: 'ENTER: RESUME  BACK: TITLE', scale: 1, emphasis: false, gapBefore: 6 },
    ],
  }).sprites;
}

/**
 * リザルト。8 台ぶんの順位とベストラップを並べる。
 *
 * 読むのは `RaceState` ではなく**量子化済みのスナップショット**なので、
 * 第1世代では 6Hz でしか更新されない — 後続がゴールして順位が入れ替わる場面が、
 * その世代の粒で見える。
 */
function resultSprites(context: ViewContext): readonly SpriteCommand[] {
  const { profile, display } = context;
  const style = generationValue(TEXT_STYLES, context.generation);
  const ordered = [...display.cars].sort((left, right) => left.standing - right.standing);

  return centeredBlock({
    id: 'result',
    context,
    style,
    panel: true,
    top: floorToTile(profile.video.internalHeight * RESULT_TOP, profile),
    lines: [
      { text: `RESULT  ${LAP_COUNT} LAPS`, scale: 2 },
      ...ordered.map((car) => ({
        // 名前を 5 文字に揃えてあるので、左揃えのままタイムの桁が縦に並ぶ
        text: `${car.standing}. ${carName(car).padEnd(5)} ${formatLapTime(car.bestLapTicks)}`,
        scale: 1,
        emphasis: car.entrant === PLAYER_ENTRANT,
        gapBefore: 3,
      })),
      { text: 'ENTER: RETRY  BACK: TITLE', scale: 1, emphasis: false, gapBefore: 6 },
    ],
  }).sprites;
}

/**
 * いまの画面に応じた文字をフレームへ積む。
 *
 * 走行中の 3 画面では HUD が別に出ているので、ここが足すのは
 * カウントダウン・GO・FINISH・ポーズだけになる。
 */
export function pushScreenOverlay(frame: RenderFrame, context: ViewContext): void {
  const sprites: SpriteCommand[] = [];

  switch (context.screen) {
    case 'title':
      sprites.push(...titleSprites(context));
      break;
    case 'countdown':
      sprites.push(...countdownSprites(context));
      break;
    case 'racing':
      if (context.state.tick <= COUNTDOWN_TICKS + GO_TICKS) sprites.push(...goSprites(context));
      break;
    case 'finished':
      if (context.screenTicks <= FINISH_TICKS) sprites.push(...finishSprites(context));
      break;
    case 'result':
      sprites.push(...resultSprites(context));
      break;
  }

  // ポーズはどの画面の上にも重なる。最後に積むので必ず最前面
  if (context.paused) sprites.push(...pausedSprites(context));

  for (const sprite of sprites) frame.sprites.push(sprite);
}
