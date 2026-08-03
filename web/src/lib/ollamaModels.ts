// SPDX-License-Identifier: Apache-2.0
// Pulse R186 — Ollama «installed models» lister.
//
// Pure функции для Ollama /api/tags. Возвращают список моделей,
// установленных в локальном Ollama. Используется компонентом
// ModelSwitcher в шапке чата (live hot-swap модели без похода в Settings).
//
// Контракт:
//   * На любую ошибку (network/parse/timeout/aborted/empty) — return [].
//     Никогда не throw. UI решает что показывать в empty-state.
//   * Sort by name (alphabetically, case-insensitive). Дефолтный порядок
//     Ollama — «most recently modified first», что для UI неудобно
//     (юзер ищет «gemma3» глазами).
//   * Parse изолирован в чистую функцию `parseOllamaTagsResponse`,
//     чтобы покрыть тестами без сети/fetch-мока.
//
// API Ollama /api/tags (см. https://github.com/ollama/ollama/blob/main/docs/api.md#list-local-models):
//   GET /api/tags → { "models": [{ name, model, modified_at, size, digest, details }, ...] }
//
// Мы не используем поле `model` (новые версии Ollama дублируют `name`).
// `details` (family, parameter_size, quantization_level) сейчас не
// парсим — R186 нужен только name + size + modified + digest.

export interface OllamaModel {
  /** Ollama tag, например "gemma3:4b" или "llama3.1:8b-instruct-q4_K_M". */
  name: string;
  /** Размер модели в байтах. 0 если Ollama не сообщил. */
  size: number;
  /** ISO-время последнего изменения ('' если неизвестно). */
  modifiedAt: string;
  /** Короткий sha256-digest модели ('' если неизвестно). */
  digest: string;
}

/** Default Ollama endpoint. Переопределяется через options.ollamaUrl. */
export const DEFAULT_OLLAMA_URL = 'http://localhost:11434';

/** Default timeout для GET /api/tags. Ollama обычно отвечает <100ms, но
 *  если сервис висит — 5s достаточно чтобы не задерживать UI. */
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Дёрнуть `GET {ollamaUrl}/api/tags` и вернуть список установленных моделей.
 *
 * На любую ошибку (network, parse, timeout, AbortError, пустой ответ) —
 * возвращает [] (UI показывает empty-state, не ломается).
 *
 * @param options.ollamaUrl    базовый URL Ollama (default localhost:11434)
 * @param options.signal       AbortSignal. Если уже aborted — return [] без fetch.
 * @param options.timeoutMs    таймаут в мс (default 5000)
 */
export async function listOllamaModels(options?: {
  ollamaUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<OllamaModel[]> {
  const ollamaUrl = options?.ollamaUrl ?? DEFAULT_OLLAMA_URL;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const signal = options?.signal;

  // Уже aborted — не дёргаем fetch вовсе.
  if (signal?.aborted) return [];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // Если передан внешний signal — связываем abort. Любой abort убьёт fetch.
  const onAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) {
      clearTimeout(timer);
      return [];
    }
    signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/tags`;
    const resp = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!resp.ok) return [];
    const json = await resp.json();
    return parseOllamaTagsResponse(json);
  } catch {
    // AbortError / network / JSON parse — все пути return [].
    return [];
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Pure parser. Принимает JSON-ответ Ollama /api/tags и возвращает
 * нормализованный список моделей, отсортированный по name (case-insensitive).
 *
 * Устойчив к мусорным/частичным ответам:
 *   * Нет ключа `models` → []
 *   * Каждая запись с отсутствующими полями → default'ы (name="unknown",
 *     size=0, modifiedAt="", digest="")
 *   * Не-массив `models` → []
 *
 * Это позволяет UI показывать хоть что-то даже при битом ответе.
 */
export function parseOllamaTagsResponse(json: unknown): OllamaModel[] {
  if (!json || typeof json !== 'object') return [];
  const root = json as { models?: unknown };
  if (!Array.isArray(root.models)) return [];
  const out: OllamaModel[] = [];
  for (const raw of root.models) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const name = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : 'unknown';
    const size = typeof r.size === 'number' && Number.isFinite(r.size) ? r.size : 0;
    const modifiedAt = typeof r.modified_at === 'string' ? r.modified_at : '';
    const digest = typeof r.digest === 'string' ? r.digest : '';
    out.push({ name, size, modifiedAt, digest });
  }
  // Sort alphabetically (case-insensitive). Stable: на одинаковых именах —
  // сохраняем порядок (V8 sort с 2003 года стабильный).
  out.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return out;
}

/** Format size in bytes → human string (e.g. "2.6 GB", "408 MB").
 *  Используется в dropdown — мелким текстом рядом с именем. */
export function formatOllamaModelSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${Math.round(bytes / MB)} MB`;
  if (bytes >= KB) return `${Math.round(bytes / KB)} KB`;
  return `${bytes} B`;
}
