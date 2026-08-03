// SPDX-License-Identifier: Apache-2.0
// R179: AI-suggested chat titles via native Ollama endpoint.
//
// Когда юзер отправляет первое сообщение в новом чате, ChatView
// fire-and-forget вызывает suggestChatTitle() — мы стучимся в
// нативный Ollama /api/generate (не /v1/chat/completions) с
// `stream: false`, `temperature: 0.3`, `num_predict: 20`. Ollama
// отдаёт короткую строку (3-7 слов), мы её чистим и возвращаем.
//
// Дизайн-решения:
//   * Pure async function, не React-hook. Caller сам решает когда
//     дёргать и что делать с результатом (ChatView: setChatTitle;
//     будущая мобильная вёрстка: тот же call, другая реакция).
//   * Никогда не throw'им. Network/parse/timeout → null. Caller
//     проверяет `if (title) ...` и тихо молчит на null.
//   * Один module-level Map<chatId, AbortController> — если юзер
//     быстро создал второй чат, а первый title ещё в полёте,
//     отменяем предыдущий, чтобы не было race с записью.
//   * Default `model: 'gemma3:4b'` — это default vision-model
//     проекта, она же хорошо работает на коротком title-prompt
//     (быстрее, чем 'gemma2:2b' для vision-mode, и стабильнее
//     на русском). Caller может override'нуть через `options.model`.
//   * Trim + truncate input до 500 chars. Для title-генерации
//     хватит начала сообщения; длинный код/логи скорее путают
//     модель, чем помогают.
//   * Output cap 40 chars — чтобы влезало в sidebar row и
//     уважало существующий truncation pattern ChatSidebar (30-40).
//   * No deps. Только встроенный fetch + AbortController.

const DEFAULT_OLLAMA_URL = 'http://localhost:11434';
const DEFAULT_MODEL = 'gemma3:4b';
const DEFAULT_TIMEOUT_MS = 8000;
const INPUT_MAX_CHARS = 500;
const OUTPUT_MAX_CHARS = 40;

/** Сколько одновременных title-запросов мы трекаем. Только для отмены предыдущего по тому же chatId. */
const inflight = new Map<string, AbortController>();

export interface SuggestTitleOptions {
  /** Ollama base URL. Default http://localhost:11434. */
  ollamaUrl?: string;
  /** Модель Ollama. Default 'gemma3:4b'. */
  model?: string;
  /** Внешний AbortSignal — caller может прервать цепочку. */
  signal?: AbortSignal;
  /** Timeout в ms. Default 8000. */
  timeoutMs?: number;
}

/**
 * Запросить у Ollama короткий (3-7 слов) title для первого сообщения чата.
 * Возвращает очищенный title или null на любой ошибке.
 *
 * NEVER throws. Caller: `if (title) ...`.
 */
export async function suggestChatTitle(
  firstMessage: string,
  options: SuggestTitleOptions = {},
): Promise<string | null> {
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    model = DEFAULT_MODEL,
    signal: externalSignal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  // chatId для дедупа: используем hash содержимого — это позволяет
  // дедупнуть запросы, даже если caller не передал явный id.
  const chatId = `msg-${hashString(firstMessage)}`;
  cancelInflight(chatId);

  const trimmed = firstMessage.trim();
  if (!trimmed) return null;

  const truncated = trimmed.length > INPUT_MAX_CHARS
    ? trimmed.slice(0, INPUT_MAX_CHARS)
    : trimmed;

  const controller = new AbortController();
  inflight.set(chatId, controller);

  // Compose timeout + external signal
  const timeoutHandle = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs);
  const onExternalAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal) {
    if (externalSignal.aborted) {
      clearTimeout(timeoutHandle);
      inflight.delete(chatId);
      return null;
    }
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  try {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/generate`;
    const prompt = buildPrompt(truncated);
    const body = JSON.stringify({
      model,
      prompt,
      stream: false,
      options: { temperature: 0.3, num_predict: 20 },
    });

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: controller.signal,
    });

    if (!resp.ok) {
      return null;
    }

    const json = await safeJson(resp);
    const raw = typeof json?.response === 'string' ? json.response : '';
    const cleaned = cleanTitle(raw);
    if (!cleaned) return null;
    return truncate(cleaned, OUTPUT_MAX_CHARS);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutHandle);
    if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
    // Удаляем только если это всё ещё наш controller — мог быть заменён
    // новым вызовом, тогда не трогаем.
    if (inflight.get(chatId) === controller) {
      inflight.delete(chatId);
    }
  }
}

function cancelInflight(chatId: string): AbortController | null {
  const cur = inflight.get(chatId);
  if (cur) {
    cur.abort(new Error('superseded'));
    inflight.delete(chatId);
    return cur;
  }
  return null;
}

function buildPrompt(firstMessage: string): string {
  return (
    'Generate a 3-7 word title for the following chat message. ' +
    'Reply with ONLY the title, no quotes, no punctuation, ' +
    'no leading phrases like "Title:". ' +
    'Message: ' + firstMessage
  );
}

function cleanTitle(raw: string): string | null {
  if (!raw) return null;
  let s = raw;

  // Multi-line: берём первую непустую строку. Модели иногда
  // продолжают объяснением после title.
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  s = lines[0];

  // Strip "Title:" / "title:" prefix (case-insensitive, опц. с whitespace).
  s = s.replace(/^title\s*:\s*/i, '');

  // Strip surrounding quotes (любая пара).
  s = s.replace(/^["'`\u201C\u2018]+|["'`\u201D\u2019]+$/g, '');

  // Strip markdown/decorations: leading "- ", "* ", "# " и т.п.
  s = s.replace(/^[-*#>\s]+/, '');

  // Trim и collapse multiple spaces.
  s = s.replace(/\s+/g, ' ').trim();

  if (!s) return null;

  // Strip trailing sentence punctuation.
  s = s.replace(/[.?!]+$/, '').trim();
  if (!s) return null;

  return s;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  // Режем по последнему пробелу до max, чтобы не обрывать слово.
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > max * 0.6) {
    return cut.slice(0, lastSpace).trim();
  }
  return cut.trim();
}

async function safeJson(resp: Response): Promise<any | null> {
  try {
    return await resp.json();
  } catch {
    return null;
  }
}

/** FNV-1a 32-bit hash. Достаточно для дедупа key'а в Map. */
function hashString(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Unsigned hex.
  return (h >>> 0).toString(16);
}

/** Test-only: очистить module state. Prod-код не должен это вызывать. */
export function __resetInflightForTests(): void {
  for (const c of inflight.values()) c.abort(new Error('test-reset'));
  inflight.clear();
}
