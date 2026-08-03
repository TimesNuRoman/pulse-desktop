// SPDX-License-Identifier: Apache-2.0
//
// R194 — vitest tests для `agentRetry.ts`.
//
// Покрывает:
//   * retries on retriable error up to maxAttempts
//   * throws after exhausting attempts
//   * exponential backoff timing (fake timers)
//   * isRetriable customization
//   * onRetry hook fires before each delay
//   * AbortError не retriable
//   * TypeError (network) retriable
//   * jitter не превышает maxDelay

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  retryWithBackoff,
  defaultIsRetriable,
  computeBackoffDelay,
  sleep,
  DEFAULT_RETRY_OPTS,
} from '../agentRetry';
import { LLMError } from '../../llm/client';

describe('retryWithBackoff', () => {
  describe('happy path', () => {
    test('returns immediately on first success', async () => {
      const fn = vi.fn().mockResolvedValue('ok');
      const r = await retryWithBackoff(fn, { isRetriable: defaultIsRetriable });
      expect(r).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on retriable error and eventually succeeds', async () => {
      const err = new LLMError(null, 'network down');
      const fn = vi
        .fn()
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce('finally');
      const r = await retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetriable: defaultIsRetriable,
      });
      expect(r).toBe('finally');
      expect(fn).toHaveBeenCalledTimes(3);
    });
  });

  describe('error handling', () => {
    test('throws after exhausting maxAttempts', async () => {
      const err = new LLMError(null, 'persistent');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          isRetriable: defaultIsRetriable,
        }),
      ).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('throws immediately on non-retriable error (no retry)', async () => {
      const err = new LLMError(401, 'unauthorized');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 5,
          baseDelayMs: 10,
          isRetriable: defaultIsRetriable,
        }),
      ).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('custom isRetriable classifier is respected', async () => {
      const customErr = new Error('custom');
      const isRetriable = vi.fn((e: unknown) => e === customErr);
      const fn = vi
        .fn()
        .mockRejectedValueOnce(customErr) // retriable по custom → retry
        .mockResolvedValueOnce('ok');
      const r = await retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 10,
        isRetriable,
      });
      expect(r).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
      expect(isRetriable).toHaveBeenCalledTimes(1);
    });

    test('custom isRetriable that rejects everything: 1 attempt, throw', async () => {
      const isRetriable = vi.fn(() => false);
      const err = new Error('nope');
      const fn = vi.fn().mockRejectedValue(err);
      await expect(
        retryWithBackoff(fn, { maxAttempts: 5, baseDelayMs: 10, isRetriable }),
      ).rejects.toBe(err);
      expect(fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('default isRetriable classifier', () => {
    test('TypeError (network error from fetch) is retriable', () => {
      expect(defaultIsRetriable(new TypeError('Failed to fetch'))).toBe(true);
    });

    test('LLMError with null status (network) is retriable', () => {
      expect(defaultIsRetriable(new LLMError(null, 'network'))).toBe(true);
    });

    test('LLMError with 5xx is retriable', () => {
      expect(defaultIsRetriable(new LLMError(500, 'server error'))).toBe(true);
      expect(defaultIsRetriable(new LLMError(502, 'bad gateway'))).toBe(true);
      expect(defaultIsRetriable(new LLMError(503, 'unavailable'))).toBe(true);
    });

    test('LLMError with 408 (timeout) is retriable', () => {
      expect(defaultIsRetriable(new LLMError(408, 'timeout'))).toBe(true);
    });

    test('LLMError with 429 (rate limit) is retriable', () => {
      expect(defaultIsRetriable(new LLMError(429, 'rate limit'))).toBe(true);
    });

    test('LLMError with 4xx (except 408/429) is NOT retriable', () => {
      expect(defaultIsRetriable(new LLMError(401, 'unauthorized'))).toBe(false);
      expect(defaultIsRetriable(new LLMError(404, 'not found'))).toBe(false);
      expect(defaultIsRetriable(new LLMError(400, 'bad request'))).toBe(false);
    });

    test('AbortError is NOT retriable (explicit cancel)', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      expect(defaultIsRetriable(e)).toBe(false);
    });

    test('plain Error without status is NOT retriable', () => {
      expect(defaultIsRetriable(new Error('validation failed'))).toBe(false);
    });

    test('null/undefined is NOT retriable', () => {
      expect(defaultIsRetriable(null)).toBe(false);
      expect(defaultIsRetriable(undefined)).toBe(false);
    });
  });

  describe('timing (fake timers)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    test('onRetry fires before each delay with correct attempt', async () => {
      const err = new LLMError(null, 'net');
      const fn = vi
        .fn()
        .mockRejectedValueOnce(err)
        .mockRejectedValueOnce(err)
        .mockResolvedValueOnce('ok');
      const onRetry = vi.fn();
      const p = retryWithBackoff(fn, {
        maxAttempts: 3,
        baseDelayMs: 500,
        maxDelayMs: 8000,
        backoffMultiplier: 2,
        isRetriable: defaultIsRetriable,
        onRetry,
      });
      // После 1-й ошибки (attempt=1) → onRetry(1, 500+jitter).
      // Проматываем время через 1000ms (500+jitter до 100ms).
      await vi.advanceTimersByTimeAsync(1000);
      // После 2-й ошибки (attempt=2) → onRetry(2, 1000+jitter).
      await vi.advanceTimersByTimeAsync(2000);
      await p;
      expect(onRetry).toHaveBeenCalledTimes(2);
      // Первый аргумент — attempt (1, 2).
      expect(onRetry.mock.calls[0]?.[0]).toBe(1);
      expect(onRetry.mock.calls[1]?.[0]).toBe(2);
      // Второй — delay (>= baseDelay).
      expect(onRetry.mock.calls[0]?.[1]).toBeGreaterThanOrEqual(500);
      expect(onRetry.mock.calls[0]?.[1]).toBeLessThanOrEqual(600); // 500 + 100 jitter
      expect(onRetry.mock.calls[1]?.[1]).toBeGreaterThanOrEqual(1000);
      expect(onRetry.mock.calls[1]?.[1]).toBeLessThanOrEqual(1100);
    });

    test('exponential backoff: delays double each attempt (before jitter)', () => {
      const opts = { baseDelayMs: 500, maxDelayMs: 8000, backoffMultiplier: 2 };
      // attempt=2 → 500, attempt=3 → 1000, attempt=4 → 2000.
      expect(computeBackoffDelay(2, opts, 0)).toBe(500);
      expect(computeBackoffDelay(3, opts, 0)).toBe(1000);
      expect(computeBackoffDelay(4, opts, 0)).toBe(2000);
      expect(computeBackoffDelay(5, opts, 0)).toBe(4000);
    });

    test('jitter does not exceed maxDelay', () => {
      // attempt=10 без cap было бы 500 * 2^8 = 128000ms → cap на 8000.
      const d = computeBackoffDelay(10, { baseDelayMs: 500, maxDelayMs: 8000, backoffMultiplier: 2 }, 99);
      expect(d).toBeLessThanOrEqual(8099);
      expect(d).toBeGreaterThanOrEqual(8000);
    });

    test('attempt=1 returns 0 (no delay before first try)', () => {
      expect(computeBackoffDelay(1, { baseDelayMs: 500, maxDelayMs: 8000, backoffMultiplier: 2 })).toBe(0);
    });
  });

  describe('abort signal', () => {
    test('throws AbortError when signal already aborted', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const fn = vi.fn();
      await expect(
        retryWithBackoff(fn, {
          maxAttempts: 3,
          baseDelayMs: 10,
          isRetriable: defaultIsRetriable,
          signal: ctrl.signal,
        }),
      ).rejects.toMatchObject({ name: 'AbortError' });
      expect(fn).not.toHaveBeenCalled();
    });
  });

  describe('defaults', () => {
    test('DEFAULT_RETRY_OPTS has expected values', () => {
      expect(DEFAULT_RETRY_OPTS.maxAttempts).toBe(3);
      expect(DEFAULT_RETRY_OPTS.baseDelayMs).toBe(500);
      expect(DEFAULT_RETRY_OPTS.maxDelayMs).toBe(8000);
      expect(DEFAULT_RETRY_OPTS.backoffMultiplier).toBe(2);
    });
  });

  describe('sleep helper', () => {
    test('sleep resolves after delay', async () => {
      vi.useFakeTimers();
      const p = sleep(100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(p).resolves.toBeUndefined();
      vi.useRealTimers();
    });

    test('sleep rejects with AbortError when signal aborts', async () => {
      vi.useFakeTimers();
      const ctrl = new AbortController();
      const p = sleep(1000, ctrl.signal);
      ctrl.abort();
      await expect(p).rejects.toMatchObject({ name: 'AbortError' });
      vi.useRealTimers();
    });
  });
});
