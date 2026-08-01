// Pulse mobile-iteration 17 — theme picker.
//
// Темы: dark (по умолчанию), light, system.
// Persist в localStorage `pulse.theme`.
// Применяется через `data-theme` на <html> и через media-query `prefers-color-scheme: dark/light`
// когда выбрано "system".

export type Theme = 'dark' | 'light' | 'system';

const LS_KEY = 'pulse.theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(LS_KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch {
    /* ignore */
  }
  return 'dark';
}

export function writeTheme(t: Theme): void {
  try {
    localStorage.setItem(LS_KEY, t);
  } catch {
    /* ignore */
  }
}

/** Применить тему к <html>. Возвращает cleanup для useEffect. */
export function applyTheme(t: Theme): () => void {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');

  function sync() {
    const effective = t === 'system' ? (mql.matches ? 'dark' : 'light') : t;
    root.setAttribute('data-theme', effective);
  }
  sync();

  let cleanup = () => {};
  if (t === 'system') {
    const handler = () => sync();
    mql.addEventListener('change', handler);
    cleanup = () => mql.removeEventListener('change', handler);
  }
  return cleanup;
}
