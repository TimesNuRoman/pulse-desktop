// SPDX-License-Identifier: Apache-2.0
// Pulse R186 — chat header model switcher.
//
// Что показывает: dropdown со списком моделей, установленных в локальном
// Ollama (`GET /api/tags`). Клик по модели — мгновенный hot-swap:
// `onSwitch(name)` поднимается в ChatView, который передаёт имя в
// `runAgentLoop` → `streamChat({ modelOverride })`.
//
// Поведение:
//   * На mount: один запрос за списком моделей. Если pollIntervalMs > 0 —
//     setInterval(refresh, pollIntervalMs) для авто-обновления (если
//     юзер параллельно `ollama pull`'нул новую модель).
//   * На любой сетевой/parse/timeout/aborted ответ listOllamaModels
//     возвращает [] — UI показывает empty-state.
//   * 3+ пустых ответов подряд → "Cannot reach Ollama" под empty-state
//     (юзеру понятно что не просто моделей нет, а сервис недоступен).
//   * Esc / клик снаружи / Enter на option — закрывает dropdown.
//   * Up/Down arrow — навигация по option'ам (focus management).
//   * Reduced motion — skip анимацию появления.
//
// a11y (WAI-ARIA listbox pattern):
//   * button: role="button" (native), aria-haspopup="listbox",
//     aria-expanded, aria-label
//   * listbox: role="listbox", aria-label
//   * options: role="option", aria-selected
//   * активный option получает focus при открытии (Enter/Space на нём же).

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  listOllamaModels,
  formatOllamaModelSize,
  type OllamaModel,
} from '../lib/ollamaModels';

interface Props {
  /** Имя текущей активной модели (e.g. "gemma3:4b"). */
  currentModel: string;
  /** Callback на выбор другой модели. Новое имя — уже сохранено в state
   *  родителя, dropdown закроется. */
  onSwitch: (modelName: string) => void;
  /** Базовый URL Ollama. Default — localhost:11434. */
  ollamaUrl?: string;
  /** Интервал автообновления списка моделей (мс). 0 = manual only.
   *  Default 0 — не дёргаем Ollama в фоне без причины. */
  pollIntervalMs?: number;
}

const REFRESH_LABEL = 'Refresh model list';
const DOCS_URL = 'https://ollama.com/';
const MAX_CONSECUTIVE_EMPTY = 3;

export function ModelSwitcher(props: Props) {
  const { currentModel, onSwitch, ollamaUrl, pollIntervalMs = 0 } = props;
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [open, setOpen] = useState(false);
  const [focusIdx, setFocusIdx] = useState(0);
  const [consecutiveEmpty, setConsecutiveEmpty] = useState(0);
  const [loading, setLoading] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  // AbortController для текущего fetch — при unmount/reload отменяем.
  const fetchAbortRef = useRef<AbortController | null>(null);

  // ─── refresh: пере-запросить /api/tags ──────────────────────────────────
  const refresh = useCallback(async () => {
    fetchAbortRef.current?.abort();
    const ac = new AbortController();
    fetchAbortRef.current = ac;
    setLoading(true);
    try {
      const list = await listOllamaModels({ ollamaUrl, signal: ac.signal });
      // После получения ответа проверяем, не отменили ли запрос пока он
      // летел (unmount или rapid refresh). Не обновляем state если abort.
      if (ac.signal.aborted) return;
      setModels(list);
      setConsecutiveEmpty((n) => (list.length === 0 ? n + 1 : 0));
    } finally {
      if (!ac.signal.aborted) setLoading(false);
    }
  }, [ollamaUrl]);

  // ─── mount: первичная загрузка ─────────────────────────────────────────
  useEffect(() => {
    void refresh();
  }, [refresh]);

  // ─── optional polling (для «юзер параллельно pull'нул модель») ─────────
  useEffect(() => {
    if (!pollIntervalMs || pollIntervalMs <= 0) return;
    const id = window.setInterval(() => void refresh(), pollIntervalMs);
    return () => window.clearInterval(id);
  }, [pollIntervalMs, refresh]);

  // ─── unmount: отменить текущий fetch ───────────────────────────────────
  useEffect(() => {
    return () => fetchAbortRef.current?.abort();
  }, []);

  // ─── close on outside click ────────────────────────────────────────────
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node | null;
      if (!t) return;
      if (buttonRef.current?.contains(t)) return;
      if (listRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // ─── close on Esc / arrow navigation ───────────────────────────────────
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLUListElement>) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
        buttonRef.current?.focus();
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocusIdx((i) => Math.min(models.length - 1, i + 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        setFocusIdx(0);
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        setFocusIdx(Math.max(0, models.length - 1));
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const m = models[focusIdx];
        if (m) {
          onSwitch(m.name);
          setOpen(false);
          buttonRef.current?.focus();
        }
      }
    },
    [models, focusIdx, onSwitch],
  );

  // При открытии: focusIdx на текущую модель (если есть в списке), иначе 0.
  // Также scrollIntoView для длинных списков.
  useEffect(() => {
    if (!open) return;
    const idx = models.findIndex((m) => m.name === currentModel);
    setFocusIdx(idx >= 0 ? idx : 0);
  }, [open, models, currentModel]);

  useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelectorAll<HTMLLIElement>('[role="option"]')?.[focusIdx];
    el?.scrollIntoView({ block: 'nearest' });
  }, [focusIdx, open]);

  // ─── render ────────────────────────────────────────────────────────────
  const caret = open ? '▴' : '▾';
  const empty = models.length === 0;
  const unreachable = empty && consecutiveEmpty >= MAX_CONSECUTIVE_EMPTY;
  const labelId = 'model-switcher-label';
  const listId = 'model-switcher-list';

  return (
    <div className="model-switcher" data-testid="model-switcher">
      <button
        ref={buttonRef}
        type="button"
        className="model-switcher__btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Change model (current: ${currentModel})`}
        aria-labelledby={`${labelId} model-switcher-current`}
        onClick={() => setOpen((o) => !o)}
        data-testid="model-switcher-btn"
      >
        <span id={labelId} className="model-switcher__btn-label">
          Model
        </span>
        <span
          id="model-switcher-current"
          className="model-switcher__btn-current"
          data-testid="model-switcher-current"
        >
          {currentModel}
        </span>
        <span aria-hidden className="model-switcher__caret">
          {caret}
        </span>
      </button>

      {open && (
        <div
          className="model-switcher__dropdown"
          role="presentation"
          data-testid="model-switcher-dropdown"
        >
          <div className="model-switcher__toolbar">
            <span className="model-switcher__toolbar-text">
              {loading
                ? 'Loading…'
                : `${models.length} model${models.length === 1 ? '' : 's'} installed`}
            </span>
            <button
              type="button"
              className="model-switcher__refresh"
              onClick={() => void refresh()}
              disabled={loading}
              aria-label={REFRESH_LABEL}
              title={REFRESH_LABEL}
              data-testid="model-switcher-refresh"
            >
              {loading ? '…' : 'Refresh'}
            </button>
          </div>

          {empty ? (
            <div className="model-switcher__empty" data-testid="model-switcher-empty">
              {unreachable ? (
                <>
                  Cannot reach Ollama. Is it running?
                  <br />
                  <a
                    href={DOCS_URL}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="model-switcher__empty-link"
                  >
                    Install / start Ollama
                  </a>
                </>
              ) : (
                <>
                  No models found.
                  <br />
                  Run <code>ollama pull gemma3:4b</code> to get started.
                </>
              )}
            </div>
          ) : (
            <ul
              ref={listRef}
              id={listId}
              className="model-switcher__list"
              role="listbox"
              aria-label="Installed Ollama models"
              tabIndex={-1}
              onKeyDown={onKeyDown}
              data-testid="model-switcher-list"
            >
              {models.map((m, i) => {
                const isCurrent = m.name === currentModel;
                const isFocused = i === focusIdx;
                const sizeLabel = formatOllamaModelSize(m.size);
                return (
                  <li
                    key={m.name}
                    role="option"
                    aria-selected={isCurrent}
                    className={
                      'model-switcher__option' +
                      (isCurrent ? ' is-current' : '') +
                      (isFocused ? ' is-focused' : '')
                    }
                    onMouseEnter={() => setFocusIdx(i)}
                    onClick={() => {
                      onSwitch(m.name);
                      setOpen(false);
                      buttonRef.current?.focus();
                    }}
                    data-testid={`model-option-${m.name}`}
                    data-current={isCurrent ? '1' : '0'}
                  >
                    <span className="model-switcher__option-name">{m.name}</span>
                    {sizeLabel && (
                      <span className="model-switcher__option-size">{sizeLabel}</span>
                    )}
                    {isCurrent && (
                      <span className="model-switcher__option-check" aria-hidden>
                        ✓
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
