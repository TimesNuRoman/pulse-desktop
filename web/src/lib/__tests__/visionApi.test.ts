// SPDX-License-Identifier: Apache-2.0
// Pulse - visionApi wrapper tests (R160).
//
// R160 ships a focused Ollama /api/chat wrapper for paste-image submit.
// These tests pin the request shape (model, messages with images array)
// and the three error branches (network, http, empty/parse). We mock
// globalThis.fetch so no real network is hit.
//
// Run: `npm test -- visionApi`.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendImageWithPrompt, VisionError } from '../visionApi';

interface FetchCall {
  url: string;
  init: RequestInit;
}

function mockFetchResponse(body: unknown, init?: { status?: number; ok?: boolean }): FetchCall {
  const status = init?.status ?? 200;
  const ok = init?.ok ?? (status >= 200 && status < 300);
  const captured: FetchCall = { url: '', init: {} as RequestInit };
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    captured.url = String(url);
    captured.init = init ?? ({} as RequestInit);
    return {
      ok,
      status,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response;
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return captured;
}

describe('sendImageWithPrompt - R160 vision API', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    // No-op setup — each test installs its own mock.
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('builds correct Ollama /api/chat body (model, messages with images array)', async () => {
    const call = mockFetchResponse({
      message: { role: 'assistant', content: 'A screenshot of a Pulse chat window.' },
    });

    const result = await sendImageWithPrompt({
      imageBase64: 'data:image/png;base64,iVBORw0KGgo=',
      prompt: 'What is in this image?',
      model: 'gemma3:4b',
    });

    // URL: Ollama native /api/chat, not the OpenAI-compat /v1/chat/completions.
    expect(call.url).toBe('http://127.0.0.1:11434/api/chat');

    // Method + content type.
    expect(call.init.method).toBe('POST');
    const headers = call.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');

    // Body shape — model, stream:false, user message with raw base64 (no data: prefix).
    const body = JSON.parse(call.init.body as string);
    expect(body.model).toBe('gemma3:4b');
    expect(body.stream).toBe(false);
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content).toBe('What is in this image?');
    // Critical: images array contains RAW base64 — Ollama rejects the
    // `data:image/png;base64,` prefix with a cryptic 400.
    expect(body.messages[0].images).toEqual(['iVBORw0KGgo=']);

    // Returned: assistant text.
    expect(result).toBe('A screenshot of a Pulse chat window.');
  });

  test('returns response.message.content', async () => {
    mockFetchResponse({
      message: { role: 'assistant', content: 'Two monitors with code.' },
    });

    const result = await sendImageWithPrompt({
      imageBase64: 'rawbase64==',
      prompt: 'describe',
    });
    expect(result).toBe('Two monitors with code.');
  });

  test('throws on network error with friendly message', async () => {
    // Simulate a fetch-level failure (no Response object returned).
    globalThis.fetch = (async () => {
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;

    await expect(
      sendImageWithPrompt({ imageBase64: 'x', prompt: 'p' }),
    ).rejects.toThrow(VisionError);

    // Friendly message — not the raw TypeError dump.
    let caught: unknown;
    try {
      await sendImageWithPrompt({ imageBase64: 'x', prompt: 'p' });
    } catch (e) {
      caught = e;
    }
    expect((caught as VisionError).code).toBe('network');
    expect((caught as Error).message).toMatch(/vision|network/i);
  });

  test('throws VisionError(http) on non-2xx response with status surfaced', async () => {
    mockFetchResponse({ error: 'model not found' }, { status: 404, ok: false });

    let caught: unknown;
    try {
      await sendImageWithPrompt({ imageBase64: 'x', prompt: 'p' });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(VisionError);
    expect((caught as VisionError).code).toBe('http');
    expect((caught as VisionError).status).toBe(404);
    expect((caught as Error).message).toMatch(/404/);
  });

  test('uses placeholder "What\'s in this image?" when prompt is empty', async () => {
    const call = mockFetchResponse({
      message: { role: 'assistant', content: 'A PNG image.' },
    });

    await sendImageWithPrompt({
      imageBase64: 'data:image/png;base64,abc',
      prompt: '', // empty — paste-image only
    });
    const body = JSON.parse(call.init.body as string);
    expect(body.messages[0].content).toBe("What's in this image?");
  });
});
