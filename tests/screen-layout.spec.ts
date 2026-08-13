import {
  GENERATION_IDS,
  HARDWARE_GENERATION_PROFILES,
  createRenderFrame,
  generationSupportsHardwareBlend,
  type GenerationId,
  type SpriteCommand,
} from '@console-chaos/engine';
import { describe, expect, it } from 'vitest';

import { stepFlow, type FlowInput, type ScreenId } from '../src/game/flow/screens.js';
import { createFlow } from '../src/game/flow/screens.js';
import { LAP_COUNT } from '../src/game/sim/state.js';
import { buildGenerationView } from '../src/game/view/index.js';
import { createDisplayLatch } from '../src/game/view/shared/display-state.js';
import { LOGO_ATLAS } from '../src/game/view/shared/font.js';
import { defaultMinimapRect } from '../src/game/view/shared/minimap.js';
import { raceAfter } from './support/frame.js';

/**
 * タイトル・カウントダウン・ポーズ・リザルトの配置（実装計画 §3.7 / §5.2）。
 *
 * 画面の文字は 4 世代で内部解像度もミニマップの寸法も違うところへ置くので、
 * 「割合で置いたら第4世代だけミニマップに重なっていた」が起きやすい
 * （実際に起きた）。ここで固定するのは 3 つ。
 *
 * 1. 画面からはみ出さない
 * 2. **ミニマップと重ならない** — 右下はミニマップの場所である
 * 3. 半透明の作法が世代と食い違わない（FC は `hardwareBlend` を 1 つも持たない）
 */

const IDLE: FlowInput = {
  control: { steer: 0, throttle: 0, brake: 0 },
  confirm: false,
  back: false,
  pause: false,
};

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** スプライトの外形。文字セルは透明な余りを含むが、重なりの判定はこれで十分 */
function boundsOf(sprites: readonly SpriteCommand[]): Rect | null {
  if (sprites.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const sprite of sprites) {
    left = Math.min(left, sprite.position[0] - sprite.size[0] / 2);
    right = Math.max(right, sprite.position[0] + sprite.size[0] / 2);
    top = Math.min(top, sprite.position[1] - sprite.size[1] / 2);
    bottom = Math.max(bottom, sprite.position[1] + sprite.size[1] / 2);
  }
  return { left, top, right, bottom };
}

function overlaps(a: Rect, b: Rect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/**
 * その画面の 1 フレームを組み立てる。
 *
 * `screen` を直に渡すのは、リザルトまで実際に走らせると 1 ケース 3 分掛かるため。
 * 遷移そのものは `flow.spec.ts` が受け持つ。
 */
function frameFor(generation: GenerationId, screen: ScreenId, paused = false) {
  const profile = HARDWARE_GENERATION_PROFILES[generation];
  const state = screen === 'title' ? titleRace() : raceAfter(3600);
  const frame = createRenderFrame();
  buildGenerationView(frame, {
    generation,
    profile,
    state,
    display: createDisplayLatch().sample(generation, profile, state),
    seconds: 2,
    renderedGenerations: 1,
    screen,
    screenTicks: 60,
    paused,
  });
  return { frame, profile };
}

function titleRace() {
  const flow = createFlow();
  for (let tick = 0; tick < 300; tick++) stepFlow(flow, IDLE);
  return flow.race;
}

function overlaySprites(sprites: readonly SpriteCommand[], prefix: string): SpriteCommand[] {
  return sprites.filter((sprite) => sprite.id.startsWith(prefix));
}

const SCREENS: ScreenId[] = ['title', 'countdown', 'racing', 'finished', 'result'];

describe('画面の配置', () => {
  for (const generation of GENERATION_IDS) {
    describe(generation, () => {
      for (const screen of SCREENS) {
        it(`${screen}: 画面からはみ出さない`, () => {
          const { frame, profile } = frameFor(generation, screen);
          const overlay = overlaySprites(frame.sprites, 'screen-');
          const bounds = boundsOf(overlay);
          if (!bounds) return; // racing は GO! が消えたあとなら何も出ない
          expect(bounds.left, '左').toBeGreaterThanOrEqual(0);
          expect(bounds.top, '上').toBeGreaterThanOrEqual(0);
          expect(bounds.right, '右').toBeLessThanOrEqual(profile.video.internalWidth);
          expect(bounds.bottom, '下').toBeLessThanOrEqual(profile.video.internalHeight);
        });
      }

      it('タイトル: ロゴ・PRESS START・操作説明が互いに重ならない', () => {
        const { frame } = frameFor(generation, 'title');
        const logo = boundsOf(overlaySprites(frame.sprites, `screen-logo-`))!;
        const prompt = boundsOf([
          ...overlaySprites(frame.sprites, `screen-panel-${generation}-title-prompt`),
          ...overlaySprites(frame.sprites, `screen-${generation}-title-prompt`),
        ])!;
        const controls = boundsOf([
          ...overlaySprites(frame.sprites, `screen-panel-${generation}-title-controls`),
          ...overlaySprites(frame.sprites, `screen-${generation}-title-controls`),
        ])!;
        expect(overlaps(logo, prompt), 'ロゴと PRESS START').toBe(false);
        expect(overlaps(prompt, controls), 'PRESS START と操作説明').toBe(false);
        expect(overlaps(logo, controls), 'ロゴと操作説明').toBe(false);
      });

      it('タイトル: ミニマップの矩形と重ならない', () => {
        // 右下はミニマップの場所。割合で置くと第4世代（176² のミニマップ）で必ず重なる
        const { frame, profile } = frameFor(generation, 'title');
        const map = defaultMinimapRect(generation, profile);
        const mapRect: Rect = {
          left: map.left,
          top: map.top,
          right: map.left + map.width,
          bottom: map.top + map.height,
        };
        for (const id of ['title-prompt', 'title-controls']) {
          const rect = boundsOf([
            ...overlaySprites(frame.sprites, `screen-panel-${generation}-${id}`),
            ...overlaySprites(frame.sprites, `screen-${generation}-${id}`),
          ]);
          expect(rect && overlaps(rect, mapRect), `${id} がミニマップに重なる`).toBe(false);
        }
        const logo = boundsOf(overlaySprites(frame.sprites, 'screen-logo-'))!;
        expect(overlaps(logo, mapRect), 'ロゴがミニマップに重なる').toBe(false);
      });

      it('タイトル: ロゴが 1 枚だけ、正しい寸法で出る', () => {
        const { frame } = frameFor(generation, 'title');
        const logo = overlaySprites(frame.sprites, 'screen-logo-');
        expect(logo).toHaveLength(1);
        const scale = logo[0]!.size[0] / LOGO_ATLAS.width;
        expect(Number.isInteger(scale), `拡大率 ${scale} が整数でない`).toBe(true);
        expect(logo[0]!.size[1]).toBe(LOGO_ATLAS.height * scale);
        expect(logo[0]!.texture).toBe(LOGO_ATLAS.url);
      });

      it('リザルト: 8 台ぶんの行と見出しが出る', () => {
        const { frame } = frameFor(generation, 'result');
        // 見出し + 8 台 + 案内 = 10 行
        // id は `screen-<世代>-result-<行>-<文字>`。影付きの世代では文字側が `s0` になる
        const lines = new Set(
          overlaySprites(frame.sprites, `screen-${generation}-result-`).map((sprite) =>
            sprite.id.replace(/-s?\d+$/, ''),
          ),
        );
        expect(lines.size).toBe(10);
        expect(LAP_COUNT).toBe(3);
      });

      it('ポーズはどの画面の上にも出る', () => {
        const { frame } = frameFor(generation, 'racing', true);
        expect(overlaySprites(frame.sprites, `screen-${generation}-paused`).length).toBeGreaterThan(
          0,
        );
      });

      it('カウントダウンと GO! が出る', () => {
        expect(
          overlaySprites(frameFor(generation, 'countdown').frame.sprites, `screen-${generation}-countdown`)
            .length,
        ).toBeGreaterThan(0);
        // racing の頭 1 秒だけ GO! が残る。`raceAfter(3600)` はとっくに過ぎている
        const early = frameFor(generation, 'racing').frame.sprites;
        expect(overlaySprites(early, `screen-${generation}-go`)).toEqual([]);
      });

      it('hardwareBlend が世代の作法と食い違わない', () => {
        for (const screen of SCREENS) {
          for (const sprite of overlaySprites(frameFor(generation, screen, true).frame.sprites, 'screen-')) {
            if (!sprite.hardwareBlend) continue;
            expect(generationSupportsHardwareBlend(generation, sprite.hardwareBlend)).toBe(true);
            expect(sprite.generations).toEqual([generation]);
          }
        }
      });
    });
  }

  it('FC はどの画面でも半透明を 1 つも積まない（translucency: none）', () => {
    // パネルは不透明で置く。実機の FC も文字の下には単色の帯を敷いていた
    for (const screen of SCREENS) {
      const { frame } = frameFor('FC', screen, true);
      const translucent = frame.sprites.filter((sprite) => sprite.hardwareBlend);
      expect(translucent.map((sprite) => sprite.id), screen).toEqual([]);
    }
  });

  it('画面の文字は必ず最前面に積まれる', () => {
    // `view/index.ts` が各世代のビューの後に積む。第1世代でも走査線制限の対象外
    for (const generation of GENERATION_IDS) {
      const { frame } = frameFor(generation, 'title');
      const ids = frame.sprites.map((sprite) => sprite.id);
      const firstOverlay = ids.findIndex((id) => id.startsWith('screen-'));
      expect(firstOverlay, generation).toBeGreaterThanOrEqual(0);
      expect(ids.slice(firstOverlay).every((id) => id.startsWith('screen-')), generation).toBe(
        true,
      );
    }
  });
});
