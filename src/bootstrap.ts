import {
  createAssetManager,
  createBrowserLoopHost,
  createGameHost,
  createGenerationAudioService,
  createGenerationWebGlRenderer,
  createKeyboardGamepadSource,
  installAudioUnlock,
  observeCanvasResize,
  type AudioService,
  type GameHost,
  type GameModule,
  type GenerationId,
  type Score,
} from '@console-chaos/engine';

import { MANIFEST } from './assets/manifest.js';
import { arrangementFor } from './game/audio/score.js';
import type { ScreenMode } from './game/view/shared/screen-mode.js';

export interface BootOptions {
  canvas: HTMLCanvasElement;
  module: GameModule;
  initialGeneration?: GenerationId;
  seed?: number;
  /**
   * 起動時に読み込む楽曲。既定は起動世代の編曲で、`GameModule` が
   * `playScore()` を呼んだ時点で実際に鳴り始める（§4.1）。
   */
  score?: Score;
  /**
   * 画面モード（実装計画 11-7）。**レンダラーが毎フレーム読む。**
   * `GameModule` と同じものを渡すので、キーで倒した値がそのまま絵に出る。
   */
  screenMode?: ScreenMode;
}

export interface BootResult {
  host: GameHost;
  audio: AudioService | null;
  dispose(): void;
}

/**
 * CRT を切った状態（開発時のみ・`?crt=off`）。
 *
 * §6.1 の「画面から色を抽出して同時 25 色以内」を**測る**ために要る。
 * 走査線・にじみ・ノイズが乗った後の画面は数千色になるので、量子化直後の色を
 * 数えるにはポストエフェクトを外すしかない。**遊ぶときの既定は常に full** で、
 * §1.4 の CRT プリセットをそのまま使う（上書きは計測の口だけ）。
 */
const FLAT_CRT = {
  scanline: 0,
  bleed: 0,
  curvature: 0,
  bloom: 0,
  vignette: 0,
  noise: 0,
  mask: 0,
} as const;

function flatCrtRequested(): boolean {
  if (!import.meta.env.DEV || typeof location === 'undefined') return false;
  return new URLSearchParams(location.search).get('crt') === 'off';
}

/**
 * AssetManager → Renderer → AudioService → GameHost の配線（実装計画 §2.4 / フェーズ 0）。
 *
 * `AudioContext` はユーザー操作の前に音を出せないので、サービスは最初から作っておき
 * `installAudioUnlock` の解錠で `resume()` させる（`createNullAudioService` への差し替えはしない）。
 */
export async function boot(options: BootOptions): Promise<BootResult> {
  const initialGeneration = options.initialGeneration ?? 'FC';
  const assets = createAssetManager();
  const renderer = await createGenerationWebGlRenderer(options.canvas, {
    assets,
    manifest: MANIFEST,
    quality: () => 'full',
    // 開発時の `?crt=off`（計測の口）が優先。それ以外は画面モードの上書きを毎フレーム読む
    ...(flatCrtRequested()
      ? { crtOverride: () => FLAT_CRT }
      : options.screenMode
        ? { crtOverride: () => options.screenMode!.crtOverride() }
        : {}),
  });

  // WebGL レンダラーの resize() は `canvas.width/height` からビューポートを張り直すだけで、
  // バックバッファの寸法は変えない。表示サイズ → バックバッファの反映はアプリの責務。
  const resizeObserver = observeCanvasResize(options.canvas, () => {
    const canvas = options.canvas;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const width = Math.max(1, Math.round((canvas.clientWidth || canvas.width) * ratio));
    const height = Math.max(1, Math.round((canvas.clientHeight || canvas.height) * ratio));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    renderer.resize();
  });

  let audio: AudioService | null = null;
  let audioUnlock: { dispose(): void } | null = null;
  const AudioContextCtor: typeof AudioContext | undefined =
    globalThis.AudioContext ??
    (globalThis as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (AudioContextCtor) {
    const context = new AudioContextCtor();
    audio = createGenerationAudioService(context, options.score ?? arrangementFor(initialGeneration));
    audioUnlock = installAudioUnlock(document, () => audio!.unlock());
  }

  const host = createGameHost({
    loopHost: createBrowserLoopHost(),
    renderer,
    input: createKeyboardGamepadSource(),
    assets,
    ...(audio ? { audio } : {}),
    initialGeneration,
    ...(options.seed === undefined ? {} : { seed: options.seed }),
  });

  await host.start(options.module);

  let disposed = false;
  return {
    host,
    audio,
    dispose() {
      if (disposed) return;
      disposed = true;
      audioUnlock?.dispose();
      resizeObserver.dispose();
      // host.dispose() が renderer / assets / audio / input をまとめて破棄する。
      host.dispose();
    },
  };
}
