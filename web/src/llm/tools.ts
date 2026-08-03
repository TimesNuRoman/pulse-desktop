// Pulse — общий веб-поиск. Обёртка над Rust-командой `web_search`
// (src-tauri/src/web_search.rs). Не путать с `agent`-tools в agent.ts —
// это для ручного/UI-использования, а здесь — поиск в интернете с
// graceful fallback'ом (DDG HTML → DDG Lite → Wikipedia).
//
// Frontend сам решает когда дёргать `webSearch` (эвристика `shouldWebSearch`),
// потому что gemma2:2b не умеет в tool calling. Результат подставляется
// в LLM-контекст как `<search_results>` блок через `formatSearchContext`.
//
// Также тут — стабы agent v5 (runAgentLoop / ToolCallEvent) для обратной
// совместимости с ChatView. Реальный tool-calling планируется в v5.1,
// пока runAgentLoop просто проксирует к streamChat (gemma2:2b всё равно
// не делает tool calls, так что поведение эквивалентно).

import { invoke } from '@tauri-apps/api/core';
import { streamChat, LLMError } from './client';
import type { LLMMessage } from './types';

export interface SearchItem {
  title: string;
  url: string;
  snippet: string;
  source: string;
  site_name: string;
}

export interface WebSearchResult {
  query: string;
  /** Какой backend реально ответил: "ddg-html" | "ddg-lite" | "wikipedia" | "none" */
  backend: string;
  total: number;
  items: SearchItem[];
  offline: boolean;
  error: string | null;
}

const IN_TAURI =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) || Boolean((window as any).__TAURI__));

/**
 * Общий веб-поиск. Возвращает структуру с массивом items + meta.
 * На пустой запрос / без Tauri — возвращает пустой результат с
 * пометкой в error, НЕ кидает.
 */
export async function webSearch(query: string, limit = 8): Promise<WebSearchResult> {
  const trimmed = query.trim();
  if (!trimmed) {
    return {
      query: '',
      backend: 'none',
      total: 0,
      items: [],
      offline: false,
      error: 'empty query',
    };
  }
  if (!IN_TAURI) {
    return {
      query: trimmed,
      backend: 'none',
      total: 0,
      items: [],
      offline: true,
      error: 'Запусти через `npm run tauri dev` (нужен Tauri-runtime).',
    };
  }
  return invoke<WebSearchResult>('web_search', { query: trimmed, limit });
}

/**
 * Эвристика: «стоит ли дёрнуть web_search перед LLM-ответом?».
 * Срабатывает на слова-маркеры: года (2024+), latest/последн/новост/релиз,
 * документация и т.п. Ложные срабатывания терпимы — на пустой результат
 * web_search просто молча вернёт offline=true.
 *
 * Правила (чтобы не ловить «Привет, у меня новый ноут» как web-search):
 *  - год 20YY считается контекстом, только если рядом есть ещё слово
 *    (не «2024» в одиночку)
 *  - «latest/последн/актуальн/новост/релиз/документация/docs» — как
 *    отдельные слова
 *  - «новый|new» — триггерит ТОЛЬКО если рядом «версия|модель|...»
 *    (раньше триггерил на «Привет, у меня новый ноут»)
 *
 * JS gotcha: \w и \b в JS — ASCII-only даже с флагом /u. Кириллицу
 * не считают «буквой». Используем `[\p{L}\p{N}_]` для Unicode-aware
 * «word character» и `(?<!\p{L})` / `(?!\p{L})` для Unicode-aware
 * границ слова.
 */
export function shouldWebSearch(text: string): boolean {
  const t = text.toLowerCase();
  // Год 20YY, за которым идёт ещё символ (не конец строки/пробел) — считаем,
  // что это контекст, а не просто «2024».
  if (/(20\d{2})(?=\s*[a-zа-яё])/u.test(t)) return true;
  // Слова-маркеры. Каждое слово — отдельный `(?:точная|форма|префикс[\w]+)`:
  // - «точная» ловит само слово как есть («релиз», «release»)
  // - «префикс+[\p{L}\p{N}_]+» ловит словоформы («последние», «актуальные»)
  // JS \b и \w ASCII-only — используем `[\p{L}\p{N}_]` для Unicode-aware.
  if (
    /(?<!\p{L})(?:latest|release|today|doc(?:s|umentation)?|сегодня|что\s+нового|релиз|релиз[\p{L}\p{N}_]+|последн[\p{L}\p{N}_]+|актуальн[\p{L}\p{N}_]+|новост[\p{L}\p{N}_]+|документаци[\p{L}\p{N}_]+)(?!\p{L})/u.test(
      t,
    )
  ) {
    return true;
  }
  // «новый|new» — только если рядом есть слово-контекст.
  if (
    /(?<!\p{L})(новый|new)(?!\p{L})/u.test(t) &&
    /(?<!\p{L})(верси\w*|version|модель|model|plugin|плагин|сервис|service|api|функци\w*|feature|обновлен\w*|update)(?!\p{L})/u.test(t)
  ) {
    return true;
  }
  return false;
}

/**
 * Превращает WebSearchResult в текстовый блок, который подставляется
 * в LLM-контекст как user-role сообщение. Формат:
 *
 *   <search_results query="..." backend="..." total="...">
 *   [1] Title — snippet
 *       url: ...
 *   [2] ...
 *   </search_results>
 *
 * LLM читает это и в конце ответа добавляет блок
 * "🔍 Источники:" (см. system prompt в prompts.ts).
 */
export function formatSearchContext(
  query: string,
  result: WebSearchResult,
  maxItems = 5,
): string {
  if (result.items.length === 0) {
    return `<search_results query="${escapeAttr(query)}" backend="${result.backend}" total="0">\n[поиск не дал результатов: ${result.error ?? 'offline'}]\n</search_results>`;
  }
  const items = result.items.slice(0, maxItems);
  const body = items
    .map(
      (it, i) =>
        `[${i + 1}] ${it.title} — ${it.snippet}\n    url: ${it.url}`,
    )
    .join('\n');
  return `<search_results query="${escapeAttr(query)}" backend="${result.backend}" total="${result.total}">\n${body}\n</search_results>`;
}

/** Экранируем кавычки в атрибутах (на случай query с `"` или `>`). */
function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

// ─── Pulse v5 — agent stubs (build unblocker) ────────────────────────────────
// TODO v5.1: заменить на полноценный agent loop с tool registry. Сейчас
// gemma2:2b не умеет в structured tool-calling, так что runAgentLoop
// просто проксирует к streamChat — поведение 1:1 как было до agent v5.

/** Событие tool-цикла, которое получает UI через callbacks. */
export type ToolCallEvent =
  | { type: 'text-delta'; delta: string }
  | { type: 'tool-start'; tool: string; args: Record<string, unknown> }
  | { type: 'tool-end'; tool: string; args: Record<string, unknown>; result: string | null; error: string | null };

export interface AgentLoopCallbacks {
  onTextDelta: (delta: string) => void;
  onToolStart?: (ev: Extract<ToolCallEvent, { type: 'tool-start' }>) => void;
  onToolEnd?: (ev: Extract<ToolCallEvent, { type: 'tool-end' }>) => void;
}

export interface AgentLoopOptions {
  messages: LLMMessage[];
  signal?: AbortSignal;
  callbacks: AgentLoopCallbacks;
  maxSteps?: number;
  /**
   * R186: override модели для этого раунда. Передаётся в `streamChat`
   * как `req.modelOverride` и используется вместо `cfg.model`/`cfg.visionModel`.
   * Если не задан — выбор модели как раньше (vision для картинок, иначе text).
   * ChatView хранит currentModel в state и пробрасывает сюда при каждом
   * вызове — model switcher в шапке делает live hot-swap.
   */
  model?: string;
}

export interface AgentLoopResult {
  text: string;
  finishReason: 'stop' | 'length' | 'cancelled' | 'error' | 'max-steps';
  error?: string;
  toolCalls: Array<{ tool: string; args: Record<string, unknown>; result: string | null; error: string | null }>;
  /** R89: routing decision от Smart Engine v3. Pass-through из streamChat.
   *  ChatView использует `result.routing?.lowConfidence` чтобы показать
   *  chip с override-опциями. См. `llm/route.ts::EngineDecision`. */
  routing?: import('./route').EngineDecision;
  /** R89: human-readable routing mode. Pass-through из streamChat. */
  routingMode?: import('./route').RoutingMode;
}

/**
 * Заглушка agent v5: один проход streamChat, tool-цикл НЕ выполняется
 * (нет tool registry). Когда в v5.1 появится JSON-mode парсер — здесь
 * будет полноценный loop с повторными вызовами LLM по tool-результатам.
 */
export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  let acc = '';
  try {
    const r = await streamChat(
      {
        messages: opts.messages,
        signal: opts.signal,
        // R186: pass-through override model из ChatView → streamChat.
        // Если opts.model пустой/undefined — streamChat возьмёт модель
        // из env/localStorage (поведение v5.1).
        modelOverride: opts.model && opts.model.trim() ? opts.model : undefined,
      },
      (delta) => {
        acc += delta;
        opts.callbacks.onTextDelta(delta);
      },
    );
    return {
      text: r.text,
      finishReason: r.finishReason,
      toolCalls: [],
      // R89: pass-through routing decision (low_confidence flag → UI chip).
      routing: r.routing,
      routingMode: r.routingMode,
    };
  } catch (e) {
    const msg = e instanceof LLMError ? e.message : `Ошибка: ${(e as Error).message}`;
    return {
      text: acc,
      finishReason: 'error',
      error: msg,
      toolCalls: [],
    };
  }
}
