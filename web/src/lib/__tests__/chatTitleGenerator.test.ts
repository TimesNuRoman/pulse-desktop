// SPDX-License-Identifier: Apache-2.0
// R179: tests for chatTitleGenerator (Ollama title-suggest).
//
// Покрывает:
//   * Happy path: prompt содержит user message, response парсится
//   * Cleaning: "Title:" prefix, surrounding quotes, trailing punct
//   * Output cap: 40 chars
//   * Input cap: 500 chars (длинное сообщение)
//   * Failure paths: network error, HTTP 5xx, empty response, timeout
//   * Config: custom ollamaUrl / model, AbortSignal
//   * Request body: model, prompt, stream=false, options.temperature/num_predict
//
// Мокаем fetch глобально через vi.stubGlobal. По умолчанию
// happy-dom уже подменяет fetch, но для точности используем
// vi.stubGlobal. Для таймаутов — vi.useFakeTimers.

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  suggestChatTitle,
  __resetInflightForTests,
} from '../chatTitleGenerator';

interface FetchCall {
  url: string;
  init: RequestInit;
}

let fetchCalls: FetchCall[];
let fetchMock: any;

beforeEach(() => {
  __resetInflightForTests();
  fetchCalls = [];
  fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    fetchCalls.push({ url, init });
    // Default: вернуть 200 с минимальным валидным Ollama-ответом.
    return new Response(JSON.stringify({ response: 'Sample Title' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  __resetInflightForTests();
});

/**
 * Хелпер: заставить fetch подвеситься (вернуть Promise, который
 * никогда не резолвится, пока не дёрнем resolve'ом или не придёт
 * abort signal). Используется для тестов на timeout/abort.
 */
function hangingFetch() {
  let resolver!: (r: Response) => void;
  let rejecter!: (e: unknown) => void;
  const p = new Promise<Response>((res, rej) => {
    resolver = res;
    rejecter = rej;
  });
  const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
    fetchCalls.push({ url: _url, init });
    // Слушаем abort: fetch должен реально отмениться, иначе вызов
    // повиснет навсегда даже после abort().
    init.signal?.addEventListener(
      'abort',
      () => rejecter(new DOMException('aborted', 'AbortError')),
      { once: true },
    );
    return p;
  });
  return { p, resolver, rejecter, fetchImpl };
}

// ─── Happy path ────────────────────────────────────────────────────────────

describe('suggestChatTitle — happy path', () => {
  test('returns parsed response', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Hello world' }), { status: 200 }),
    );

    const title = await suggestChatTitle('say hi');

    expect(title).toBe('Hello world');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('prompt contains user message', async () => {
    await suggestChatTitle('What is the meaning of life?');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/generate');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.stream).toBe(false);
    expect(body.prompt).toContain('What is the meaning of life?');
    expect(body.prompt).toContain('3-7 word title');
  });

  test('request body has temperature 0.3 and num_predict 20', async () => {
    await suggestChatTitle('hi');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}');
    expect(body.options.temperature).toBe(0.3);
    expect(body.options.num_predict).toBe(20);
  });

  test('default model is gemma3:4b', async () => {
    await suggestChatTitle('hi');
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}');
    expect(body.model).toBe('gemma3:4b');
  });
});

// ─── Cleaning ─────────────────────────────────────────────────────────────

describe('suggestChatTitle — cleaning', () => {
  test('strips "Title: " prefix', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Title: My Chat Topic' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('My Chat Topic');
  });

  test('strips "title:" prefix (lowercase)', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'title: lowercase prefix' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('lowercase prefix');
  });

  test('strips surrounding double quotes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: '"Quoted Title"' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Quoted Title');
  });

  test('strips surrounding smart quotes', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: '\u201CSmart Quoted\u201D' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Smart Quoted');
  });

  test('strips trailing period', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Title with period.' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Title with period');
  });

  test('strips trailing question mark', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Is this a question?' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Is this a question');
  });

  test('strips trailing exclamation', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Excited title!' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Excited title');
  });

  test('takes only the first non-empty line', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'First line\nSecond line explanation' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('First line');
  });

  test('strips leading markdown decoration', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: '- Markdown title' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Markdown title');
  });

  test('collapses internal whitespace', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 'Too    many   spaces' }), { status: 200 }),
    );
    expect(await suggestChatTitle('msg')).toBe('Too many spaces');
  });
});

// ─── Length caps ──────────────────────────────────────────────────────────

describe('suggestChatTitle — length caps', () => {
  test('truncates output to 40 chars', async () => {
    const long = 'A '.repeat(30); // 60 chars
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: long.trim() }), { status: 200 }),
    );
    const out = await suggestChatTitle('msg');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(40);
  });

  test('truncation prefers word boundary when possible', async () => {
    // 50 chars: "alpha beta gamma delta epsilon zeta eta theta" = 47 chars
    // truncate(40) должен обрезать по последнему пробелу
    const long = 'alpha beta gamma delta epsilon zeta eta theta iota';
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: long }), { status: 200 }),
    );
    const out = await suggestChatTitle('msg');
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(40);
    expect(out!.endsWith('iota')).toBe(false); // обрезано до последнего слова
  });

  test('truncates input to 500 chars (long message test)', async () => {
    const longInput = 'x'.repeat(2000);
    await suggestChatTitle(longInput);
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}');
    // The prompt contains the message; extract the part after "Message: " and
    // verify it's ≤ 500 chars of x's (plus the rest of the prompt suffix).
    const prompt: string = body.prompt;
    const idx = prompt.indexOf('Message: ');
    const after = prompt.slice(idx + 'Message: '.length);
    expect(after.length).toBeLessThanOrEqual(500);
    // Should not throw on huge input.
  });
});

// ─── Failure paths ────────────────────────────────────────────────────────

describe('suggestChatTitle — failure paths', () => {
  test('network error returns null (no throw)', async () => {
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('HTTP 500 returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Internal Server Error', { status: 500 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('HTTP 404 returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Not Found', { status: 404 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('empty response field returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: '' }), { status: 200 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('whitespace-only response returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: '   \n  \t  ' }), { status: 200 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('non-string response field returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ response: 12345 }), { status: 200 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('malformed JSON returns null', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('not-json-at-all{{{', { status: 200 }),
    );
    const out = await suggestChatTitle('hi');
    expect(out).toBeNull();
  });

  test('empty input returns null without calling fetch', async () => {
    const out = await suggestChatTitle('   ');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('empty input "" returns null', async () => {
    const out = await suggestChatTitle('');
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Timeout ──────────────────────────────────────────────────────────────

describe('suggestChatTitle — timeout', () => {
  test('timeout (8s default) returns null', async () => {
    vi.useFakeTimers();
    const { p, fetchImpl } = hangingFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const promise = suggestChatTitle('hi');
    // Attach a no-op catch so unhandled rejection warnings don't fire.
    promise.catch(() => undefined);

    // Advance past the default 8000ms timeout.
    await vi.advanceTimersByTimeAsync(8001);

    const out = await promise;
    expect(out).toBeNull();
    void p;
  });

  test('custom timeoutMs honored', async () => {
    vi.useFakeTimers();
    const { p, fetchImpl } = hangingFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const promise = suggestChatTitle('hi', { timeoutMs: 500 });
    promise.catch(() => undefined);

    // Не должен сработать на 499ms.
    await vi.advanceTimersByTimeAsync(499);
    // На 501ms — должен.
    await vi.advanceTimersByTimeAsync(2);

    const out = await promise;
    expect(out).toBeNull();
    void p;
  });
});

// ─── Options ──────────────────────────────────────────────────────────────

describe('suggestChatTitle — options', () => {
  test('custom ollamaUrl is used', async () => {
    await suggestChatTitle('hi', { ollamaUrl: 'http://192.168.1.50:11434' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://192.168.1.50:11434/api/generate');
  });

  test('trailing slash in ollamaUrl is stripped', async () => {
    await suggestChatTitle('hi', { ollamaUrl: 'http://localhost:11434/' });
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://localhost:11434/api/generate');
  });

  test('custom model is sent in body', async () => {
    await suggestChatTitle('hi', { model: 'llama3.2:3b' });
    const body = JSON.parse((fetchMock.mock.calls[0]?.[1]?.body as string) ?? '{}');
    expect(body.model).toBe('llama3.2:3b');
  });

  test('external AbortSignal cancels the call', async () => {
    vi.useFakeTimers();
    const { p, fetchImpl } = hangingFetch();
    vi.stubGlobal('fetch', fetchImpl);

    const ext = new AbortController();
    const promise = suggestChatTitle('hi', { signal: ext.signal });
    promise.catch(() => undefined);

    // Abort извне до истечения timeout'а.
    ext.abort();
    await vi.advanceTimersByTimeAsync(0);

    const out = await promise;
    expect(out).toBeNull();
    void p;
  });

  test('pre-aborted signal returns null without calling fetch', async () => {
    const ext = new AbortController();
    ext.abort();
    const out = await suggestChatTitle('hi', { signal: ext.signal });
    expect(out).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─── Dedupe / supersede ───────────────────────────────────────────────────

describe('suggestChatTitle — inflight dedupe', () => {
  test('second call with same message cancels first', async () => {
    vi.useFakeTimers();
    let firstAborted = false;
    let secondResolve!: (r: Response) => void;
    const secondP = new Promise<Response>((res) => {
      secondResolve = res;
    });

    let callCount = 0;
    const fetchImpl = vi.fn(async (_url: string, init: RequestInit = {}) => {
      callCount++;
      if (callCount === 1) {
        // Первый call — подвешиваем и слушаем abort.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            firstAborted = true;
            reject(new DOMException('aborted', 'AbortError'));
          });
        });
      }
      // Второй call — резолвим успешно.
      return secondP;
    });
    vi.stubGlobal('fetch', fetchImpl);

    const p1 = suggestChatTitle('same message');
    p1.catch(() => undefined);
    // Продвигаем timer'ы, чтобы fetch реально стартовал.
    await vi.advanceTimersByTimeAsync(0);

    const p2 = suggestChatTitle('same message');
    p2.catch(() => undefined);
    // p2 должен вытеснить p1.
    await vi.advanceTimersByTimeAsync(0);

    // Завершаем второй запрос успешно.
    secondResolve(new Response(JSON.stringify({ response: 'Final' }), { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(firstAborted).toBe(true);
    expect(r1).toBeNull();
    expect(r2).toBe('Final');
  });
});
