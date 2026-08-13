import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  createRenderFrame,
  generationSupportsHardwareBlend,
  generationValue,
  type GenerationId,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepRace } from '../src/game/sim/race.js';
import { createDisplayLatch } from '../src/game/view/shared/display-state.js';
import { FONT_ATLAS, fontAdvance, measureText } from '../src/game/view/shared/font.js';
import { GENERATION_LABELS, buildHud, hudLines, pushHud } from '../src/game/view/shared/hud.js';
import { safeAreaOf } from '../src/game/view/shared/variants.js';
import { buildFrame, raceAfter } from './support/frame.js';

/**
 * HUD（実装計画 §3.5 / §6.1）。
 *
 * `OverlayCommand` が WebGL レンダラーで描かれないため、文字はスクリーン空間
 * スプライトで出している。ここで固定するのは 3 つ。
 *
 * 1. **書いてある数字が 4 世代で一致する** — ミニマップと同じ「1 つのシミュレーション」
 *    の主張の文字版。違うのは色・拡大率・字送り・半透明の作法だけ
 * 2. **安全領域からはみ出さない** — オーバースキャンで切れると HUD の意味が無い
 * 3. **能力契約** — FC は半透明を持たず、字がタイル境界へ載る
 */

const MOMENTS = [60, 900, 1500, 3600];

function snapshotAt(generation: GenerationId, ticks: number) {
  const profile = HARDWARE_GENERATION_PROFILES[generation];
  const state = raceAfter(ticks);
  return { profile, display: createDisplayLatch().sample(generation, profile, state) };
}

describe('HUD', () => {
  it('4 世代とも同じ数字を表示する（世代で変わるのは名札だけ）', () => {
    for (const ticks of MOMENTS) {
      const perGeneration = GENERATION_IDS.map((generation) => {
        const { display } = snapshotAt(generation, ticks);
        return hudLines(display, '');
      });
      // 更新レートが違うので、同じ tick でも FC は 10 ティック前の値を見ている。
      // 比べるのは**同じ表示フレームに落ちる瞬間**として、60 の倍数の tick を選んである
      for (const lines of perGeneration) {
        expect(lines.map((block) => block.id)).toEqual(['standing', 'laptime', 'speed']);
      }
      const [first] = perGeneration;
      for (const lines of perGeneration.slice(1)) {
        expect(lines.map((block) => block.lines.map((line) => line.text))).toEqual(
          first!.map((block) => block.lines.map((line) => line.text)),
        );
      }
    }
  });

  it('順位・周回・速度・ラップタイムがすべて出ている', () => {
    const { display } = snapshotAt('PS2', 3600);
    const label = generationValue(GENERATION_LABELS, 'PS2');
    const texts = hudLines(display, label).flatMap((block) => block.lines.map((line) => line.text));
    expect(texts.some((text) => /^POS \d\/8$/.test(text))).toBe(true);
    expect(texts.some((text) => /^LAP \d\/3$/.test(text))).toBe(true);
    expect(texts.some((text) => /^TIME [\d-]/.test(text))).toBe(true);
    expect(texts.some((text) => /^BEST [\d-]/.test(text))).toBe(true);
    expect(texts.some((text) => /^\s*\d+ KM\/H$/.test(text))).toBe(true);
    expect(texts).toContain(label);
  });

  it('名札はチャンネル表記で、番号が世代選択キーと対応する（8-8）', () => {
    // `1`〜`4` キー（8-7）と番号が一致していることが、
    // 「テレビのチャンネルを回すと世代が変わる」という見立ての根拠になる
    GENERATION_IDS.forEach((generation, index) => {
      expect(generationValue(GENERATION_LABELS, generation)).toBe(
        `CH ${index + 1} : ${['1ST', '2ND', '3RD', '4TH'][index]} GEN`,
      );
    });
  });

  it('名札は左上の塊の 1 行目で、左下は速度 1 行だけになる（8-8）', () => {
    const { display } = snapshotAt('PS1', 1500);
    const blocks = hudLines(display, generationValue(GENERATION_LABELS, 'PS1'));
    expect(blocks[0]!.id).toBe('standing');
    expect(blocks[0]!.lines[0]!.text).toBe('CH 3 : 3RD GEN');
    expect(blocks[0]!.lines.length).toBe(3);
    expect(blocks[2]!.id).toBe('speed');
    expect(blocks[2]!.lines.length).toBe(1);
  });

  it('ラップタイムの 2 行が同じ字数で、桁が縦に揃う', () => {
    // 左揃えのままで数字の位置を揃えるための決まり。字数が違うと桁がずれる
    const { display } = snapshotAt('SFC', 3600);
    const laptime = hudLines(display, '')[1]!;
    expect(laptime.id).toBe('laptime');
    expect(laptime.lines[0]!.text.length).toBe(laptime.lines[1]!.text.length);
  });

  for (const generation of GENERATION_IDS) {
    describe(generation, () => {
      it('すべての塊が安全領域の内側に収まる', () => {
        const { profile, display } = snapshotAt(generation, 1500);
        const safe = safeAreaOf(profile);
        for (const block of buildHud({ generation, profile, display }).blocks) {
          expect(block.left, `${block.id} の左`).toBeGreaterThanOrEqual(safe.left);
          expect(block.top, `${block.id} の上`).toBeGreaterThanOrEqual(safe.top);
          expect(block.left + block.width, `${block.id} の右`).toBeLessThanOrEqual(
            safe.left + safe.width,
          );
          expect(block.top + block.height, `${block.id} の下`).toBeLessThanOrEqual(
            safe.top + safe.height,
          );
        }
      });

      it('塊どうしが重ならない（左上・右上・左下）', () => {
        const { profile, display } = snapshotAt(generation, 1500);
        const blocks = buildHud({ generation, profile, display }).blocks;
        for (let a = 0; a < blocks.length; a++) {
          for (let b = a + 1; b < blocks.length; b++) {
            const left = blocks[a]!;
            const right = blocks[b]!;
            const overlaps =
              left.left < right.left + right.width &&
              right.left < left.left + left.width &&
              left.top < right.top + right.height &&
              right.top < left.top + left.height;
            expect(overlaps, `${left.id} と ${right.id} が重なる`).toBe(false);
          }
        }
      });

      it('hardwareBlend が世代の作法と食い違わない', () => {
        const { profile, display } = snapshotAt(generation, 1500);
        for (const sprite of buildHud({ generation, profile, display }).sprites) {
          if (!sprite.hardwareBlend) continue;
          expect(generationSupportsHardwareBlend(generation, sprite.hardwareBlend)).toBe(true);
          expect(sprite.generations).toEqual([generation]);
        }
      });

      it('文字はフォントアトラスのセルを引く', () => {
        const { profile, display } = snapshotAt(generation, 1500);
        const sprites = buildHud({ generation, profile, display }).sprites;
        expect(sprites.length).toBeGreaterThan(0);
        for (const sprite of sprites) {
          expect(sprite.screenSpace).toBe(true);
          expect(sprite.texture).toBe(FONT_ATLAS.url);
          expect(sprite.cell).toBeGreaterThanOrEqual(0);
          expect(sprite.cell).toBeLessThan(FONT_ATLAS.columns * FONT_ATLAS.rows);
        }
      });
    });
  }

  it('FC は半透明を 1 つも積まず、字がタイル境界へ載る', () => {
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const snap = profile.video.tileSnap;
    const { display } = snapshotAt('FC', 1500);
    const view = buildHud({ generation: 'FC', profile, display });

    expect(view.sprites.filter((sprite) => sprite.hardwareBlend)).toEqual([]);
    // 字送りがタイルの一辺そのものになるので、塊の左端が載れば全部の文字が載る
    expect(fontAdvance(snap)).toBe(snap);
    for (const block of view.blocks) {
      expect(block.left % snap, `${block.id} の左端`).toBe(0);
      expect(block.top % snap, `${block.id} の上端`).toBe(0);
    }
    for (const sprite of view.sprites) {
      // スプライトの中心はセルの左上から半セルぶんずれる。左上に戻して確かめる
      const left = sprite.position[0] - sprite.size[0] / 2;
      const top = sprite.position[1] - sprite.size[1] / 2;
      expect(left % snap, `${sprite.id} の X`).toBe(0);
      expect(top % snap, `${sprite.id} の Y`).toBe(0);
    }
  });

  it('SFC は字送りが詰まり、影が付く（FC との差がそのまま世代の差）', () => {
    const profile = HARDWARE_GENERATION_PROFILES.SFC;
    const { display } = snapshotAt('SFC', 1500);
    const view = buildHud({ generation: 'SFC', profile, display });

    expect(fontAdvance(profile.video.tileSnap)).toBe(FONT_ATLAS.advance);
    expect(measureText('BEST 1:22.100', 1, 6)).toBeLessThan(measureText('BEST 1:22.100', 1, 8));
    // 影は本体より先に積まれる（後に積んだものが手前）
    const shadows = view.sprites.filter((sprite) => sprite.id.includes('-s'));
    expect(shadows.length).toBeGreaterThan(0);
  });

  it('PS1 / PS2 は半透明パネルを持ち、PS2 だけが任意の不透明度を出せる', () => {
    for (const generation of ['PS1', 'PS2'] as const) {
      const { profile, display } = snapshotAt(generation, 1500);
      const panels = buildHud({ generation, profile, display }).sprites.filter((sprite) =>
        sprite.id.startsWith('hud-panel-'),
      );
      expect(panels.length).toBe(3);
      for (const panel of panels) expect(panel.hardwareBlend).toBeDefined();
    }
    const { profile, display } = snapshotAt('PS2', 1500);
    const panel = buildHud({ generation: 'PS2', profile, display }).sprites.find((sprite) =>
      sprite.id.startsWith('hud-panel-'),
    );
    expect(panel!.hardwareBlend).toMatchObject({ family: 'gen4-gs', opacity: 0.62 });
  });

  it('ラップタイムが表示の更新レートで止まる（第1世代の時計は 6Hz）', () => {
    // `RaceState.tick` を直接読むと、車が 6Hz なのに時計だけ 60Hz で回ってしまう
    const profile = HARDWARE_GENERATION_PROFILES.FC;
    const latch = createDisplayLatch();
    const state = raceAfter(1500);
    const seen = new Set<string>();
    for (let step = 0; step < 10; step++) {
      const display = latch.sample('FC', profile, state);
      seen.add(hudLines(display, '')[1]!.lines[0]!.text);
      stepRace(state);
    }
    // 10 ティック ＝ FC の 1 表示フレーム。時計の表示は 1 種類しか出てはいけない
    expect(seen.size).toBe(1);
  });

  it('4 世代とも HUD がフレームへ積まれる', () => {
    for (const generation of GENERATION_IDS) {
      const frame = buildFrame(generation, raceAfter(1500));
      const hud = frame.sprites.filter((sprite) => sprite.id.startsWith('hud-'));
      expect(hud.length, generation).toBeGreaterThan(0);
    }
  });

  it('pushHud が積む順は buildHud の並びと同じ', () => {
    const { profile, display } = snapshotAt('PS1', 1500);
    const frame = createRenderFrame();
    const view = pushHud(frame, { generation: 'PS1', profile, display });
    expect(frame.sprites.map((sprite) => sprite.id)).toEqual(
      view.sprites.map((sprite) => sprite.id),
    );
    // パネルが文字より先 ＝ 奥に積まれている
    expect(frame.sprites[0]!.id).toMatch(/^hud-panel-/);
  });
});
