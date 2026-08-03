// SPDX-License-Identifier: Apache-2.0
//
// Agent v3.1 — retry-обёртка с экспоненциальным backoff'ом и jitter'ом.
//
// Используется в `runAgentLoop` для оборачивания `streamChat` (и любых
// других сетевых вызовов LLM). Классифицирует ошибки на retriable / fatal:
// сетевые сбои, таймауты, 5xx — повторяем; 4xx, валидация, ProRequired —
// сразу пробрасываем наверх (ретрай не спасёт).
//
// Зачем jitter: при параллельных запросах к одному бэкенду (например, 10
// чатов одновременно дёрнули streamChat и тот вернул 503) — все клиенты
// без jitter'а повторят через одинаковую задержку и снова упрутся в
// перегруженный бэкенд. Jitter разбрасывает задержки по [0..100ms] и
// сглаживает «thundering herd».

import { LLMError } from '../llm/client';

/** Классификатор ошибки: retriable = true → повторяем, иначе пробрасываем. */
export type RetriablePredicate = (err: unknown) => boolean;

/** Колбэк перед каждой задержкой (для telemetry/logging). */
export type RetryHook = (attempt: number, delayMs: number, err: unknown) => void;

export interface RetryOpts {
  /** Макс. попыток (включая первую). По умолчанию 3. */
  maxAttempts: number;
  /** Базовая задержка в мс (для attempt=2). По умолчанию 500. */
  baseDelayMs: number;
  /** Верхняя граница задержки в мс. По умолчанию 8000. */
  maxDelayMs: number;
  /** Множитель экспоненты. По умолчанию 2 (500 → 1000 → 2000 → ...). */
  backoffMultiplier: number;
  /** Классификатор: retriable или нет. */
  isRetriable: RetriablePredicate;
  /** Колбэк перед каждой задержкой (опц.). */
  onRetry?: RetryHook;
  /** Опц.: AbortSignal — отменяет retry-цикл (и текущий sleep). */
  signal?: AbortSignal;
}

/** Дефолтные значения RetryOpts (всё кроме isRetriable). */
export const DEFAULT_RETRY_OPTS: Omit<RetryOpts, 'isRetriable' | 'onRetry'> = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8000,
  backoffMultiplier: 2,
};

/**
 * Дефолтный классификатор: повторяем на network/5xx/timeout/AbortError
 * (AbortError — НЕ retriable, abort — это явный сигнал отмены).
 *
 * Специально НЕ retriable:
 *   - AbortError (пользователь отменил — повторять бессмысленно)
 *   - 4xx (неправильный запрос, нет смысла retry)
 *   - ProRequiredError, любые Error без .status и без TypeError
 */
export const defaultIsRetriable: RetriablePredicate = (err: unknown): boolean => {
  if (err == null) return false;
  // AbortError — всегда НЕ retriable (это явный cancel).
  if (err instanceof Error && err.name === 'AbortError') return false;
  // TypeError — обычно network error в fetch (Failed to fetch / Load failed).
  if (err instanceof TypeError) return true;
  // LLMError с известным статусом.
  if (err instanceof LLMError) {
    if (err.status === null) {
      // Сетевая ошибка без HTTP-статуса (сеть, парсинг, stream cut).
      return true;
    }
    if (err.status >= 500 && err.status < 600) return true;
    if (err.status === 408 || err.status === 429) return true; // timeout / rate limit
    return false;
  }
  // Любой другой Error без явного статуса — НЕ retriable.
  // (валидация, логика, ProRequired — retry не поможет).
  return false;
};

/**
 * Сон `ms` миллисекунд. Выделено в отдельную функцию, чтобы тесты могли
 * подменить через vi.spyOn(retry, 'sleep') или просто прокинуть свой
 * sleeper через замыкание. По умолчанию — реальный setTimeout.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      cleanup();
      reject(new DOMException('Aborted', 'AbortError'));
    };
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Вычислить задержку для попытки `attempt` (1-based: attempt=1 — это
 * первая попытка, после неё задержка не нужна; attempt=2 — задержка перед
 * второй попыткой). Формула:
 *
 *   delay = min(baseDelay * multiplier^(attempt-2), maxDelay) + jitter
 *
 * где jitter — равномерно в [0..100ms]. `attempt=2` → baseDelay (500ms).
 */
export function computeBackoffDelay(
  attempt: number,
  opts: Pick<RetryOpts, 'baseDelayMs' | 'maxDelayMs' | 'backoffMultiplier'>,
  jitter: number = Math.random() * 100,
): number {
  if (attempt < 2) return 0;
  const exp = Math.pow(opts.backoffMultiplier, attempt - 2);
  const raw = opts.baseDelayMs * exp;
  const capped = Math.min(raw, opts.maxDelayMs);
  return Math.round(capped + jitter);
}

/**
 * Обернуть произвольную async-функцию в retry-цикл с экспоненциальным
 * backoff'ом. Если `fn` бросает retriable-ошибку — повторяет до
 * `maxAttempts` раз, между попытками спит `computeBackoffDelay(attempt)`.
 * Если `fn` бросает non-retriable ошибку (или исчерпали попытки) —
 * пробрасывает последнюю ошибку наверх.
 *
 * @throws последняя ошибка `fn` после исчерпания попыток (или non-retriable).
 * @throws AbortError, если signal.aborted во время сна.
 */
export async function retryWithBackoff<T>(
  fn: () => Promise<T>,
  opts: Partial<RetryOpts> & { isRetriable?: RetriablePredicate } = {},
): Promise<T> {
  const isRetriable = opts.isRetriable ?? defaultIsRetriable;
  const maxAttempts = opts.maxAttempts ?? DEFAULT_RETRY_OPTS.maxAttempts;
  const baseDelayMs = opts.baseDelayMs ?? DEFAULT_RETRY_OPTS.baseDelayMs;
  const maxDelayMs = opts.maxDelayMs ?? DEFAULT_RETRY_OPTS.maxDelayMs;
  const backoffMultiplier = opts.backoffMultiplier ?? DEFAULT_RETRY_OPTS.backoffMultiplier;
  const onRetry = opts.onRetry;
  const signal = opts.signal;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      // Если не retriable — сразу пробрасываем, не тратим попытки.
      if (!isRetriable(e)) {
        throw e;
      }
      // Последняя попытка — тоже пробрасываем.
      if (attempt >= maxAttempts) {
        throw e;
      }
      // Планируем задержку + jitter.
      const delay = computeBackoffDelay(
        attempt + 1,
        { baseDelayMs, maxDelayMs, backoffMultiplier },
      );
      if (onRetry) onRetry(attempt, delay, e);
      await sleep(delay, signal);
    }
  }
  // Достижимо только если maxAttempts < 1 — защита от misconfig.
  throw lastErr ?? new Error('retryWithBackoff: maxAttempts must be >= 1');
}
