// Pulse — R89: pure helpers для low_confidence UI (chip + override modal).
//
// Этот модуль — extracted testable logic для ChatView. Без React, без
// DOM-зависимостей (кроме localStorage), pure functions + I/O wrappers.
// Цель — 5+ vitest тестов в `__tests__/routing-ui.test.ts` покрывают
// именно эту логику, а не React rendering.
//
// Pulse UI rules (R89):
//   * DARK only (Tokyo Night) — no light theme
//   * NO emoji в production (Roman's hard rule)
//   * NO "revolutionary/amazing/disrupting" copy
//   * localStorage key: pulse.routing.override

import type { RoutingMode } from './route';

/** localStorage key для последнего user override'а. */
export const LS_ROUTING_OVERRIDE = 'pulse.routing.override';

/** Безопасно читаем localStorage. Может кинуть в incognito/SSR — глотаем. */
function readLS(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

function writeLS(key: string, value: string | null): void {
  try {
    if (typeof localStorage === 'undefined') return;
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* ignore quota / SecurityError */
  }
}

/** Список всех routing mode'ов. Используется для validate override'а. */
const ALL_MODES: readonly RoutingMode[] = [
  'CodeEdit',
  'Vision',
  'QuickAnswer',
  'Reasoning',
  'Default',
] as const;

/**
 * Прочитать сохранённый override. Возвращает только валидный RoutingMode
 * (если в localStorage мусор — null). localStorage может отсутствовать
 * (SSR, incognito) — оба глотаем.
 */
export function readRoutingOverride(): RoutingMode | null {
  const v = readLS(LS_ROUTING_OVERRIDE);
  if (!v) return null;
  return (ALL_MODES as readonly string[]).includes(v) ? (v as RoutingMode) : null;
}

/**
 * Сохранить override. `null` = сбросить (delete ключ из localStorage).
 * Используется когда юзер кликнул "Use CodeEdit next time" в modal
 * или "Reset" в settings (когда добавим).
 */
export function writeRoutingOverride(mode: RoutingMode | null): void {
  writeLS(LS_ROUTING_OVERRIDE, mode);
}

/**
 * Текст для chip'а над ассистент-сообщением. Показывается только при
 * `low_confidence === true`. R86 follow-up: до R89 чип не показывался,
 * юзеры роутились silently.
 *
 * @example
 *   formatChipText('CodeEdit')
 *   // → "Smart Engine wasn't sure — routed to CodeEdit. Tap to see why."
 */
export function formatChipText(mode: RoutingMode): string {
  // Чёткая инструкция без "amazing/revolutionary". Сразу объясняем что
  // произошло + что делать.
  return `Smart Engine wasn't sure — routed to ${mode}. Tap to see why.`;
}

/**
 * Текст для заголовка override-modal'а. Показывается при клике на chip.
 *
 * @example
 *   formatModalTitle('CodeEdit')
 *   // → "Why CodeEdit?"
 */
export function formatModalTitle(mode: RoutingMode): string {
  return `Why ${mode}?`;
}

/**
 * Категория, в которой движок выбрал этот mode (для объяснения в modal).
 * Возвращаем просто "code edit" / "quick answer" / etc — без emoji,
 * без marketing слов. R89 не анализируем полный fired-list, только
 * preferred_model → friendly category.
 */
export function routingModeCategory(mode: RoutingMode): string {
  switch (mode) {
    case 'CodeEdit':
      return 'code-edit (code generation / refactor)';
    case 'Vision':
      return 'vision (image / screenshot analysis)';
    case 'QuickAnswer':
      return 'quick answer (short factual / chat)';
    case 'Reasoning':
      return 'reasoning (long-form analysis / math)';
    case 'Default':
    default:
      return 'default fallback';
  }
}

/**
 * Описание причины low_confidence для modal'а. Использует сигналы из
 * `EngineDecision` чтобы объяснить юзеру что именно было неясно.
 */
export interface ConfidenceSignals {
  codeParseSignal: boolean;
  fired: string[];
  score: number;
  threshold: number;
}

export function explainLowConfidence(signals: ConfidenceSignals): string {
  if (signals.codeParseSignal) {
    // Парсер подтвердил код — но движок всё равно flip'нулся с low
    // confidence. Это редкий edge case (например, несколько категорий
    // смешались).
    return 'Code was detected, but routing was still uncertain.';
  }
  if (signals.fired.includes('code-parse-pending')) {
    return 'Detected code-edit intent (Russian verb or marker) but no parseable code block was found.';
  }
  if (signals.fired.length === 0) {
    return 'No strong signals found — default routing was kept.';
  }
  return `Signals: ${signals.fired.join(', ')}. Score ${signals.score}/${signals.threshold}.`;
}
