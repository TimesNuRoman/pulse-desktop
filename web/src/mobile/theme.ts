// Pulse mobile-iteration 17 — theme picker.
//
// Pulse — dark-only by design (R95 Designer #2, R96b). Option set сокращён
// с {dark, light, system} до {dark, system}. Light CSS в styles.css (1725+)
// оставлен как dead code — он не активируется без data-theme="light", который
// теперь никто не выставляет. Полная зачистка light-CSS = R97+ scope.
//
// Persist в localStorage `pulse.theme`. Миграция: при чтении legacy "light"
// в LS — falls back to 'dark' (R96b).

export type Theme = 'dark' | 'system';

const LS_KEY = 'pulse.theme';

export function readTheme(): Theme {
  try {
    const v = localStorage.getItem(LS_KEY);
    // Legacy 'light' → 'dark' (Pulse is dark-only).
    if (v === 'dark' || v === 'system') return v;
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

/** Применить тему к <html>. Возвращает cleanup для useEffect.
 *
 *  Pulse is dark-only — system mode resolves to 'dark' на любой OS, и при
 *  смене prefers-color-scheme data-theme остаётся 'dark'. Listener оставлен,
 *  чтобы при будущем включении light theme (R97+) достаточно было расширить
 *  enum + эту функцию, без переписывания App.tsx.
 */
export function applyTheme(t: Theme): () => void {
  if (typeof document === 'undefined') return () => {};
  const root = document.documentElement;
  const mql = window.matchMedia('(prefers-color-scheme: dark)');

  function sync() {
    root.setAttribute('data-theme', 'dark');
  }
  sync();

  if (t === 'system') {
    const handler = () => sync();
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }
  return () => {};
}
