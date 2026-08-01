// Pulse — обёртка над Rust-командой `engine_decide` (Tauri v2).
//
// R89: добавлено как часть R86 follow-up. Engine в Rust уже умеет
// маркировать `low_confidence` (R82 tree-sitter), но фронт про это
// не знал — ChatView ходил в Ollama напрямую через `streamChat`.
// Этот модуль — мост: дёргает Tauri-команду, возвращает типобезопасный
// `EngineDecision` для UI chip'а.
//
// Tauri v2 конвертит snake_case Rust-поля в camelCase на JS-стороне
// автоматически (см. https://tauri.app/v1/guides/features/command/#serialization),
// поэтому `preferred_model` → `preferredModel`, `low_confidence` → `lowConfidence`.

import { invoke } from '@tauri-apps/api/core';

/** Решение Smart Engine v3 (R86 / R79 Phase 3 / R82 tree-sitter).
 *
 *  Зеркало Rust-структуры `EngineDecision` из
 *  `src-tauri/src/engine/smart_engine.rs`.
 *
 *  Tauri v2 auto-converts snake_case → camelCase:
 *    preferred_model    → preferredModel
 *    fallback_model     → fallbackModel
 *    code_parse_signal  → codeParseSignal
 *    low_confidence     → lowConfidence
 */
export interface EngineDecision {
  /** Какая модель выбрана ("code" | "vision" | "fast" | "large" | "default"). */
  preferredModel: string;
  /** Какая модель была бы без auto-prefer (env / override). */
  fallbackModel: string;
  /** Список сработавших условий: ["code-edit", "code-parse-pending", ...]. */
  fired: string[];
  /** Суммарный score (>= threshold → flipped). */
  score: number;
  /** Конкретный threshold, который применился. */
  threshold: number;
  /** true если preferred != fallback и score >= threshold. */
  flipped: boolean;
  /** R82: tree-sitter подтвердил что в user_text есть parseable code. */
  codeParseSignal: boolean;
  /** R82: code-edit flip'нулся, но parser не подтвердил (только verb intent). */
  lowConfidence: boolean;
}

/** Human-readable имя routing mode'а для UI (R89).
 *
 *  Дубликат Rust-функции `routing_mode_for()` — нужна на фронте чтобы
 *  рендерить chip без round-trip'а. Держим в синхроне с
 *  `src-tauri/src/engine/smart_engine.rs::routing_mode_for`.
 */
export type RoutingMode = 'CodeEdit' | 'Vision' | 'QuickAnswer' | 'Reasoning' | 'Default';

export function routingModeFor(model: string): RoutingMode {
  switch (model) {
    case 'code':
      return 'CodeEdit';
    case 'vision':
      return 'Vision';
    case 'fast':
      return 'QuickAnswer';
    case 'large':
      return 'Reasoning';
    case 'default':
    default:
      return 'Default';
  }
}

const IN_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) || Boolean((window as any).__TAURI__));

/** Категория задачи (передаётся в engine_decide для category bonus). */
export type RouteCategory = 'code-edit' | 'reasoning' | 'chat' | 'tool-use' | '';

/**
 * Дёрнуть Smart Engine v3 — pure routing decision (dry-run, без Ollama call).
 *
 * Tauri-команда `engine_decide` в `src-tauri/src/lib.rs:397`:
 *   - вычисляет EngineDecision (без HTTP, < 1ms)
 *   - НЕ вызывает Ollama
 *   - НЕ пишет в ab.jsonl (это делает только `engine_invoke`)
 *
 * Используется в ChatView перед `streamChat` чтобы получить low_confidence
 * флаг и routing_mode для UI chip'а. Если Tauri не доступен (web/mobile)
 * — возвращаем no-op decision (lowConfidence=false, routingMode=Default).
 */
export async function engineDecide(
  userText: string,
  fallback: string,
  hasImage: boolean,
  category: RouteCategory = '',
): Promise<EngineDecision> {
  if (!IN_TAURI) {
    return {
      preferredModel: fallback,
      fallbackModel: fallback,
      fired: [],
      score: 0,
      threshold: 5,
      flipped: false,
      codeParseSignal: false,
      lowConfidence: false,
    };
  }
  return invoke<EngineDecision>('engine_decide', {
    userText,
    fallback,
    hasImage,
    category: category || null,
  });
}

/**
 * Реальный invoke — routing + Ollama call + ab.jsonl. В R89 не используется
 * в ChatView (streamChat идёт напрямую в Ollama для streaming), но
 * экспортируется для будущих интеграций (R90+) и для SettingsView
 * "Test routing" кнопки.
 */
export interface InvokeResult {
  decision: EngineDecision;
  response: string;
  latencyMs: number;
  routingMs: number;
  httpMs: number;
  logWritten: boolean;
  logPath: string | null;
  /** R89: human-readable routing mode для UI. */
  routingMode: RoutingMode;
}

export async function engineInvoke(
  userText: string,
  fallback: string,
  hasImage: boolean,
  category: RouteCategory = '',
  passThreshold: number = 5,
): Promise<InvokeResult> {
  if (!IN_TAURI) {
    throw new Error('engine_invoke: нужно Tauri-окружение (npm run tauri dev).');
  }
  return invoke<InvokeResult>('engine_invoke', {
    userText,
    fallback,
    hasImage,
    category: category || null,
    passThreshold,
  });
}
