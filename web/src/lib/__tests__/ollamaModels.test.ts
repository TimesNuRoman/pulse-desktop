// SPDX-License-Identifier: Apache-2.0
// Pulse R186 — tests for ollamaModels.ts.
//
// Покрывает:
//   * listOllamaModels: успех, пустой ответ, network error, timeout,
//     уже-aborted signal, custom URL/timeout
//   * parseOllamaTagsResponse: валидный input, отсутствующие поля,
//     мусорный JSON, 50 моделей, сортировка
//   * formatOllamaModelSize: GB/MB/KB/B
//
// Fetch мокаем глобально (vi.stubGlobal). happy-dom (test env) даёт
// fetch + AbortController + setTimeout, всё что нам нужно.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  listOllamaModels,
  parseOllamaTagsResponse,
  formatOllamaModelSize,
  DEFAULT_OLLAMA_URL,
  DEFAULT_TIMEOUT_MS,
} from '../ollamaModels';

// ─── helpers ──────────────────────────────────────────────────────────────

/** Mock Response compatible with fetch. ok + status + json(). */
function mockResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

/** Mock fetch и достаём последний URL. */
function installFetchMock(impl: (url: string, init?: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const mock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = typeof url === 'string' ? url : url.toString();
    calls.push({ url: u, init });
    return impl(u, init);
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

// ─── tests ────────────────────────────────────────────────────────────────

describe('parseOllamaTagsResponse', () => {
  test('returns [] for null / undefined / non-object', () => {
    expect(parseOllamaTagsResponse(null)).toEqual([]);
    expect(parseOllamaTagsResponse(undefined)).toEqual([]);
    expect(parseOllamaTagsResponse('garbage')).toEqual([]);
    expect(parseOllamaTagsResponse(42)).toEqual([]);
  });

  test('returns [] when models key is missing', () => {
    expect(parseOllamaTagsResponse({})).toEqual([]);
    expect(parseOllamaTagsResponse({ other: 'field' })).toEqual([]);
  });

  test('returns [] when models is not an array', () => {
    expect(parseOllamaTagsResponse({ models: 'string' })).toEqual([]);
    expect(parseOllamaTagsResponse({ models: null })).toEqual([]);
    expect(parseOllamaTagsResponse({ models: 42 })).toEqual([]);
  });

  test('parses valid models array and sorts alphabetically (case-insensitive)', () => {
    const input = {
      models: [
        { name: 'mistral:7b', size: 4_100_000_000, modified_at: '2025-12-01T00:00:00Z', digest: 'sha256:abc' },
        { name: 'gemma3:4b', size: 2_600_000_000, modified_at: '2025-11-01T00:00:00Z', digest: 'sha256:def' },
        { name: 'Llama3.1:8B', size: 4_700_000_000, modified_at: '2025-10-01T00:00:00Z', digest: 'sha256:ghi' },
      ],
    };
    const out = parseOllamaTagsResponse(input);
    // Case-insensitive sort: gemma3, llama3.1, mistral
    expect(out.map((m) => m.name)).toEqual(['gemma3:4b', 'Llama3.1:8B', 'mistral:7b']);
    expect(out[0].size).toBe(2_600_000_000);
    expect(out[0].modifiedAt).toBe('2025-11-01T00:00:00Z');
    expect(out[0].digest).toBe('sha256:def');
  });

  test('fills defaults for missing fields per-model', () => {
    const input = {
      models: [
        {}, // все поля отсутствуют → name="unknown", size=0, etc
        { name: '' }, // пустая name → "unknown"
        { name: 'gemma3:4b' }, // только name
      ],
    };
    const out = parseOllamaTagsResponse(input);
    expect(out).toHaveLength(3);
    // Sort: gemma3:4b (g) < unknown (u) — два "unknown" идут после gemma3
    expect(out[0].name).toBe('gemma3:4b');
    expect(out[0].size).toBe(0);
    expect(out[1].name).toBe('unknown');
    expect(out[1].size).toBe(0);
    expect(out[1].modifiedAt).toBe('');
    expect(out[1].digest).toBe('');
    expect(out[2].name).toBe('unknown');
  });

  test('skips non-object entries in models array', () => {
    const input = {
      models: [null, 'string', 42, { name: 'gemma3:4b' }, undefined],
    };
    const out = parseOllamaTagsResponse(input);
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('gemma3:4b');
  });

  test('parses 50 models and sorts all', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({
      name: `model-${String(i).padStart(2, '0')}:7b`,
      size: 4_000_000_000,
      modified_at: '2025-01-01T00:00:00Z',
      digest: 'sha256:x',
    }));
    const out = parseOllamaTagsResponse({ models: items });
    expect(out).toHaveLength(50);
    // Alphabetical
    expect(out[0].name).toBe('model-00:7b');
    expect(out[49].name).toBe('model-49:7b');
  });

  test('rejects non-finite size (NaN, Infinity) → 0', () => {
    const input = {
      models: [
        { name: 'gemma3:4b', size: NaN },
        { name: 'mistral:7b', size: Infinity },
        { name: 'llama3:8b', size: -100 },
      ],
    };
    const out = parseOllamaTagsResponse(input);
    // Sort: gemma3 < llama3 < mistral
    expect(out[0].name).toBe('gemma3:4b');
    expect(out[0].size).toBe(0); // NaN → 0
    expect(out[1].name).toBe('llama3:8b');
    expect(out[1].size).toBe(-100); // negative — НЕ отбрасываем, Number.isFinite=true
    expect(out[2].name).toBe('mistral:7b');
    expect(out[2].size).toBe(0); // Infinity → 0
  });
});

describe('listOllamaModels — fetch integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('successful call → parsed and sorted', async () => {
    const body = {
      models: [
        { name: 'mistral:7b', size: 4_000_000_000, modified_at: 't', digest: 'd' },
        { name: 'gemma3:4b', size: 2_600_000_000, modified_at: 't', digest: 'd' },
      ],
    };
    const { mock, calls } = installFetchMock(async () => mockResponse(body));
    const out = await listOllamaModels();
    expect(out.map((m) => m.name)).toEqual(['gemma3:4b', 'mistral:7b']);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(calls[0].url).toBe(`${DEFAULT_OLLAMA_URL}/api/tags`);
  });

  test('empty models array → []', async () => {
    installFetchMock(async () => mockResponse({ models: [] }));
    expect(await listOllamaModels()).toEqual([]);
  });

  test('network error (fetch throws) → []', async () => {
    installFetchMock(async () => {
      throw new Error('ECONNREFUSED');
    });
    expect(await listOllamaModels()).toEqual([]);
  });

  test('non-ok HTTP status → []', async () => {
    installFetchMock(async () => mockResponse('not found', false, 404));
    expect(await listOllamaModels()).toEqual([]);
  });

  test('malformed JSON (json() throws) → []', async () => {
    installFetchMock(async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token');
      },
    } as unknown as Response));
    expect(await listOllamaModels()).toEqual([]);
  });

  test('already-aborted signal → [] without firing fetch', async () => {
    const { mock } = installFetchMock(async () => mockResponse({ models: [] }));
    const controller = new AbortController();
    controller.abort();
    const out = await listOllamaModels({ signal: controller.signal });
    expect(out).toEqual([]);
    expect(mock).not.toHaveBeenCalled();
  });

  test('custom ollamaUrl → URL constructed correctly', async () => {
    const { calls } = installFetchMock(async () => mockResponse({ models: [] }));
    await listOllamaModels({ ollamaUrl: 'http://example.com:9999/ollama' });
    expect(calls[0].url).toBe('http://example.com:9999/ollama/api/tags');
  });

  test('trailing slash on ollamaUrl is stripped', async () => {
    const { calls } = installFetchMock(async () => mockResponse({ models: [] }));
    await listOllamaModels({ ollamaUrl: 'http://localhost:11434///' });
    expect(calls[0].url).toBe('http://localhost:11434/api/tags');
  });

  test('aborted during fetch → [] (timeout fires abort)', async () => {
    installFetchMock(async (_url, init) => {
      // Имитируем зависший fetch: ждём сигнал abort, потом throw.
      const signal = (init as RequestInit | undefined)?.signal;
      if (signal) {
        await new Promise<void>((resolve) => {
          if ((signal as AbortSignal).aborted) return resolve();
          (signal as AbortSignal).addEventListener('abort', () => resolve());
        });
      }
      throw new DOMException('aborted', 'AbortError');
    });
    // timeoutMs=10 — fetch почти мгновенно за-abort'ится.
    const out = await listOllamaModels({ timeoutMs: 10 });
    expect(out).toEqual([]);
  });

  test('default timeoutMs is 5000', () => {
    expect(DEFAULT_TIMEOUT_MS).toBe(5000);
  });
});

describe('formatOllamaModelSize', () => {
  test('GB (binary, 1024-based)', () => {
    // 2.6 GB exactly (2.6 * 1024^3 = 2791728742.4)
    expect(formatOllamaModelSize(Math.round(2.6 * 1024 ** 3))).toBe('2.6 GB');
    // 4.7 GB
    expect(formatOllamaModelSize(Math.round(4.7 * 1024 ** 3))).toBe('4.7 GB');
  });
  test('MB', () => {
    // 500 MB exactly
    expect(formatOllamaModelSize(500 * 1024 ** 2)).toBe('500 MB');
    // 389 MB (just below GB threshold)
    expect(formatOllamaModelSize(389 * 1024 ** 2)).toBe('389 MB');
  });
  test('KB', () => {
    expect(formatOllamaModelSize(2048)).toBe('2 KB');
  });
  test('B', () => {
    expect(formatOllamaModelSize(500)).toBe('500 B');
  });
  test('invalid (0, negative, NaN) → empty string', () => {
    expect(formatOllamaModelSize(0)).toBe('');
    expect(formatOllamaModelSize(-1)).toBe('');
    expect(formatOllamaModelSize(NaN)).toBe('');
  });
});
