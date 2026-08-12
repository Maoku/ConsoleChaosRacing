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
}

export interface BootResult {
  host: GameHost;
  audio: AudioService | null;
  dispose(): void;
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
