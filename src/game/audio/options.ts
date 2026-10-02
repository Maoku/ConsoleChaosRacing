import type { AudioService } from '@console-chaos/engine';

/** Independent, versioned audio preferences; unavailable storage never prevents play. */
export function installAudioOptions(audio: AudioService, storageKey: string): () => void {
  let options = { fds: false, bgm: 0.8, sfx: 0.8, silent: false };
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<typeof options> | null;
    if (saved) options = {
      fds: saved.fds === true, silent: saved.silent === true,
      bgm: typeof saved.bgm === 'number' && Number.isFinite(saved.bgm) ? Math.max(0, Math.min(1, saved.bgm)) : 0.8,
      sfx: typeof saved.sfx === 'number' && Number.isFinite(saved.sfx) ? Math.max(0, Math.min(1, saved.sfx)) : 0.8,
    };
  } catch { /* Storage is optional. */ }
  const panel = document.createElement('details');
  panel.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:10000;background:#101827ee;color:#edf3ff;padding:10px;border:1px solid #5e839c;border-radius:8px;font:14px sans-serif;max-width:300px';
  panel.innerHTML = '<summary>音声設定</summary><label style="display:block;margin:10px 0">第1世代の音源 <select aria-label="第1世代の音源"><option value="apu">FC 通常音源</option><option value="fds">FC + FDS 拡張音源</option></select></label><small>拡張音源は第1世代のみ有効</small>';
  const select = panel.querySelector('select')!;
  select.value = options.fds ? 'fds' : 'apu';
  const apply = () => {
    audio.setGen1Expansion?.(options.fds);
    audio.setMix?.(options.bgm, options.sfx, options.silent);
    try { localStorage.setItem(storageKey, JSON.stringify(options)); } catch { /* optional */ }
  };
  select.onchange = () => { options.fds = select.value === 'fds'; apply(); void audio.unlock().catch(() => {}); };
  for (const key of ['bgm', 'sfx'] as const) {
    const label = document.createElement('label');
    label.style.cssText = 'display:block;margin:10px 0';
    label.textContent = key === 'bgm' ? 'BGM ' : '効果音 ';
    const input = document.createElement('input');
    input.type = 'range'; input.min = '0'; input.max = '1'; input.step = '0.01'; input.value = String(options[key]);
    input.setAttribute('aria-label', key === 'bgm' ? 'BGM音量' : '効果音音量');
    input.oninput = () => { options[key] = Number(input.value); apply(); };
    label.append(input); panel.append(label);
  }
  const muteLabel = document.createElement('label');
  const mute = document.createElement('input'); mute.type = 'checkbox'; mute.checked = options.silent;
  mute.onchange = () => { options.silent = mute.checked; apply(); };
  muteLabel.append(mute, ' 全音声ミュート'); panel.append(muteLabel);
  // Keep keyboard navigation inside controls from changing the game's generation.
  panel.addEventListener('keydown', event => event.stopPropagation());
  document.body.append(panel); apply();
  const visibility = () => audio.setPaused?.(document.hidden, 'visibility');
  document.addEventListener('visibilitychange', visibility); visibility();
  return () => { document.removeEventListener('visibilitychange', visibility); panel.remove(); };
}
