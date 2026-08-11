import { boot } from './bootstrap.js';
import { racingModule } from './game/module.js';

const canvas = document.querySelector<HTMLCanvasElement>('#game');
if (!canvas) throw new Error('Missing #game canvas');

const bootOverlay = document.querySelector<HTMLElement>('#boot');

function fail(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  if (bootOverlay) {
    bootOverlay.hidden = false;
    bootOverlay.textContent = `起動に失敗しました: ${message}`;
  }
  throw error;
}

try {
  const session = await boot({ canvas, module: racingModule, initialGeneration: 'FC' });
  if (bootOverlay) bootOverlay.hidden = true;

  if (import.meta.env.DEV) {
    // 開発時の手動検証用。バックグラウンドタブでは requestAnimationFrame が
    // 止まるため、コンソールから host.frame() を直接叩けるようにしておく。
    (window as unknown as { racing?: unknown }).racing = session;
  }

  // ブラウザのショートカットに食われないよう、ゲームが使うキーは既定動作を止める。
  const swallowed = new Set([
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Space',
    'KeyZ',
    'KeyX',
    'KeyQ',
    'KeyE',
  ]);
  const onKeyDown = (event: KeyboardEvent) => {
    if (swallowed.has(event.code)) event.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown);

  window.addEventListener(
    'pagehide',
    () => {
      window.removeEventListener('keydown', onKeyDown);
      session.dispose();
    },
    { once: true },
  );
} catch (error) {
  fail(error);
}
