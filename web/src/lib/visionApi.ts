// SPDX-License-Identifier: Apache-2.0
// Pulse - vision API wrapper (R160).
//
// Single-shot wrapper around Ollama's native /api/chat endpoint for image +
// prompt pairs coming from clipboard paste. Bypasses the agent loop / tool
// calls / streaming — pasting an image is a "quick vision" use case where
// the user just wants a one-shot answer, not a full agent round-trip.
//
// R87 already wires multimodal through the OpenAI-compatible /v1/chat/
// completions endpoint (see llm/client.ts → buildMultimodalMessage +
// streamChat). R160 does NOT replace that path — screenshot, file
// attachment and existing in-chat images still flow through R87. R160 only
// adds a focused single-call surface for the paste-image preview button,
// which is testable in isolation without spinning up the whole agent.
//
// Protocol: Ollama's native /api/chat accepts `images: [base64]` as a
// top-level field on the user message (NOT the OpenAI image_url format).
// We send raw base64 (no `data:` prefix) — that's the Ollama convention.

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434';
const DEFAULT_VISION_MODEL = 'gemma3:4b';
const FETCH_TIMEOUT_MS = 60_000;

export interface VisionRequest {
  /** Image as data URL (`data:image/png;base64,...`) or raw base64. */
  imageBase64: string;
  /** User prompt. Empty string is allowed — caller should pass a placeholder. */
  prompt: string;
  /** Vision model name. Defaults to `gemma3:4b`. */
  model?: string;
  /** Ollama base URL. Defaults to `http://127.0.0.1:11434`. */
  baseUrl?: string;
}

/**
 * Strip the `data:<mime>;base64,` prefix if present. Ollama wants raw base64
 * in the `images` array; an accidentally-included prefix makes Ollama
 * return a 400 with a cryptic "invalid character" error.
 */
function stripDataUrlPrefix(s: string): string {
  const idx = s.indexOf('base64,');
  if (idx >= 0) return s.slice(idx + 'base64,'.length);
  // Also handle `data:image/png;` without the `base64,` marker — just trim
  // the `data:image/xxx;` portion. Defensive — shouldn't happen in practice.
  if (s.startsWith('data:')) {
    const semi = s.indexOf(';');
    if (semi >= 0) return s.slice(semi + 1).replace(/^base64,?/, '');
  }
  return s;
}

/** Vision-only error so callers can distinguish from generic LLMError. */
export class VisionError extends Error {
  readonly code: 'network' | 'http' | 'parse' | 'empty';
  readonly status?: number;
  constructor(code: VisionError['code'], message: string, status?: number) {
    super(message);
    this.name = 'VisionError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Send image + prompt to Ollama and return the assistant's text response.
 * Non-streaming — single JSON round-trip. Throws `VisionError` on any
 * failure (network, non-2xx, malformed body, empty response).
 *
 * Tests mock `globalThis.fetch` — no Tauri / no real network required.
 */
export async function sendImageWithPrompt(req: VisionRequest): Promise<string> {
  const baseUrl = (req.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
  const model = req.model ?? DEFAULT_VISION_MODEL;
  const image = stripDataUrlPrefix(req.imageBase64);
  const prompt = req.prompt || "What's in this image?";

  const body = {
    model,
    stream: false,
    messages: [
      {
        role: 'user',
        content: prompt,
        images: [image],
      },
    ],
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(
    () => controller.abort(),
    FETCH_TIMEOUT_MS,
  );

  let res: Response;
  try {
    res = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // AbortError comes from the timeout. Surface as a friendly network error
    // so the UI shows the same message regardless of cause.
    const isAbort = e instanceof DOMException && e.name === 'AbortError';
    throw new VisionError(
      'network',
      isAbort
        ? `Vision timeout after ${Math.round(FETCH_TIMEOUT_MS / 1000)}s — Ollama не отвечает.`
        : `Vision network error: ${msg}`,
    );
  } finally {
    clearTimeout(timeoutId);
  }

  if (!res.ok) {
    let detail = '';
    try {
      detail = (await res.text()).slice(0, 200);
    } catch {
      // ignore — body may be unreadable on some failures
    }
    throw new VisionError(
      'http',
      `Vision HTTP ${res.status} from Ollama${detail ? `: ${detail}` : ''}`,
      res.status,
    );
  }

  let json: unknown;
  try {
    json = await res.json();
  } catch (e) {
    throw new VisionError(
      'parse',
      `Vision: malformed JSON from Ollama: ${(e as Error).message}`,
    );
  }

  // Ollama /api/chat non-streaming response:
  //   { message: { role: 'assistant', content: '...' }, ... }
  const content = (json as { message?: { content?: unknown } })?.message?.content;
  if (typeof content !== 'string' || content.length === 0) {
    throw new VisionError('empty', 'Vision: empty response from Ollama');
  }
  return content;
}
