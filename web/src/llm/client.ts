// LLM-клиент: OpenAI-совместимый streaming endpoint.
// По умолчанию: локальный Ollama на http://127.0.0.1:11434/v1 (LM Studio-формат
// совместимый с OpenAI). Переключается на любого OpenAI-compatible провайдера
// через VITE_LLM_BASE_URL / VITE_LLM_MODEL.
//
// Pulse v5.1 — multimodal (vision):
//   * `LLMMessage.content` теперь `string | ContentPart[]` (см. types.ts).
//   * Если в messages есть image_url — клиент автоматически переключается
//     на vision-capable модель (VITE_LLM_VISION_MODEL, default `gemma3:4b`).
//   * Если visionModel не задан и в messages есть image — кидаем понятную
//     ошибку (чтобы не отправлять картинку в text-модель молча).
//   * Пользователь может override-ить модель через localStorage
//     `pulse.model.override` (UI: Settings).
//
// API-ключ берётся из import.meta.env.VITE_LLM_API_KEY. Ollama не проверяет
// (можно любую строку, по дефолту 'ollama'); для облачных провайдеров —
// обязателен. Никаких ключей в коде.

// R194: re-export agent v3.1 loop. Реальная логика живёт в `runAgentLoop.ts`,
// здесь только публичный API-фасад. Не модифицируем существующий код —
// конфликт-риск с unmerged-ветками (R186/R188/R176/R191).
export { runAgentLoop } from './runAgentLoop';

import type {
  ChatRequest,
  ContentPart,
  LLMMessage,
  ModelCapabilities,
  StreamChunk,
  StreamResult,
} from './types';
import { hasImageContent, messagesHaveImages } from './types';
import { PULSE_SYSTEM_PROMPT } from './prompts';
// R89: Smart Engine v3 routing decision (low_confidence flag для UI chip).
// Вызываем параллельно с Ollama fetch — добавляет ~5ms latency только
// в Tauri-runtime, на web/mobile no-op. Engine decision нужен ПОСЛЕ стрима
// (когда UI рендерит чип), поэтому можно дёргать после fetch — не блокирует
// первый chunk.
import { engineDecide, routingModeFor } from './route';

const DEFAULT_BASE_URL = 'http://127.0.0.1:11434/v1';
const DEFAULT_TEXT_MODEL = 'gemma2:2b';
const DEFAULT_VISION_MODEL = 'gemma3:4b';
const DEFAULT_API_KEY = 'ollama';

/** localStorage-ключ для override модели из Settings. */
const LS_MODEL_OVERRIDE = 'pulse.model.override';
/** localStorage-ключ для override vision-модели (опц., не критично). */
const LS_VISION_OVERRIDE = 'pulse.visionModel.override';

interface ResolvedConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  visionModel: string;
}

/** Эвристика по имени модели: vision-capable или нет. */
const VISION_MODEL_HINTS = [
  'gemma3',
  'llava',
  'vision',
  'vl',
  'minicpm-v',
  'qwen-vl',
  'qwen2-vl',
  'pixtral',
  'molmo',
  'llama3.2-vision',
  'bakllava',
  'cogvlm',
];

export function getModelCapabilities(model: string): ModelCapabilities {
  const m = model.toLowerCase();
  const vision = VISION_MODEL_HINTS.some((hint) => m.includes(hint));
  // Нативный tool-use через `tools` параметр — пока не используем (всё
  // через JSON-mode). В будущем можно добавить lookup-таблицу.
  const tools = false;
  return { vision, tools };
}

/** Безопасно читаем localStorage (может кинуть в incognito/SSR). */
function readLS(key: string): string | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
  } catch {
    return null;
  }
}

/** Считываем конфиг из env + localStorage override. */
function resolveConfig(): ResolvedConfig {
  const env = (import.meta as any).env ?? {};
  const apiKey = (env.VITE_LLM_API_KEY as string | undefined) ?? DEFAULT_API_KEY;
  const baseUrl = ((env.VITE_LLM_BASE_URL as string | undefined) ?? DEFAULT_BASE_URL).replace(
    /\/$/,
    '',
  );
  const envModel = (env.VITE_LLM_MODEL as string | undefined) ?? DEFAULT_TEXT_MODEL;
  const envVision =
    (env.VITE_LLM_VISION_MODEL as string | undefined) ?? DEFAULT_VISION_MODEL;
  // Override из Settings (localStorage). Если пусто или null — берём env.
  const lsModel = readLS(LS_MODEL_OVERRIDE);
  const lsVision = readLS(LS_VISION_OVERRIDE);
  return {
    apiKey,
    baseUrl,
    model: lsModel && lsModel.trim() ? lsModel : envModel,
    visionModel: lsVision && lsVision.trim() ? lsVision : envVision,
  };
}

/** Публичный геттер, чтобы UI мог показать «какой провайдер сейчас активен». */
export function getLLMConfig(): {
  baseUrl: string;
  model: string;
  visionModel: string;
  hasKey: boolean;
} {
  const c = resolveConfig();
  return {
    baseUrl: c.baseUrl,
    model: c.model,
    visionModel: c.visionModel,
    hasKey: Boolean(c.apiKey),
  };
}

/** Человекочитаемое имя провайдера по baseUrl. */
export function getProviderName(): string {
  const { baseUrl } = resolveConfig();
  if (baseUrl.includes('openai.com')) return 'OpenAI';
  if (baseUrl.includes('openrouter.ai')) return 'OpenRouter';
  if (baseUrl.includes('anthropic.com')) return 'Anthropic';
  if (baseUrl.includes(':1234') || baseUrl.includes('lmstudio')) return 'LM Studio';
  if (baseUrl.includes(':11434') || baseUrl.includes('ollama')) return 'Ollama';
  if (baseUrl.includes('localhost') || baseUrl.includes('127.0.0.1')) return 'локальный';
  return 'custom';
}

interface OpenAIChoice {
  index: number;
  delta?: { content?: string; role?: string };
  finish_reason?: string | null;
}

interface OpenAIStreamChunk {
  id: string;
  object: string;
  choices: OpenAIChoice[];
}

/** Парсим SSE-чанк: `data: {...}\n\n`. Возвращает массив JSON-строк после `data:`. */
function parseSSEChunk(buffer: string): { events: OpenAIStreamChunk[]; rest: string } {
  const events: OpenAIStreamChunk[] = [];
  const parts = buffer.split('\n\n');
  const rest = parts.pop() ?? '';
  for (const part of parts) {
    const lines = part.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (payload === '[DONE]') continue;
      try {
        const parsed = JSON.parse(payload) as OpenAIStreamChunk;
        events.push(parsed);
      } catch {
        // heartbeat/комментарии — игнорируем
      }
    }
  }
  return { events, rest };
}

export class LLMError extends Error {
  constructor(
    public readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}

/**
 * Сформировать OpenAI-style content array из текста + опциональной картинки.
 * Используется UI (ChatView) при отправке скриншота / прикреплённой картинки.
 *
 * @param text         текст юзера (или системный промпт)
 * @param imageDataUrl data: URL картинки (полный, с префиксом `data:image/...;base64,`)
 *                     или null/undefined если без картинки
 * @param detail       OpenAI-стиль детальности (только для совместимости; Ollama игнорирует)
 */
export function buildMultimodalMessage(
  text: string,
  imageDataUrl?: string | null,
  detail: 'low' | 'high' | 'auto' = 'auto',
): string | ContentPart[] {
  if (!imageDataUrl) return text;
  return [
    { type: 'text', text },
    { type: 'image_url', image_url: { url: imageDataUrl, detail } },
  ];
}

/**
 * Выбрать модель по содержимому messages. Если есть image — visionModel,
 * иначе — text model. Если visionModel пустой/не задан, а image есть —
 * бросает понятную ошибку (лучше явно, чем молча слать в text-модель).
 */
function resolveModelForMessages(
  cfg: ResolvedConfig,
  messages: LLMMessage[],
): { model: string; switchedToVision: boolean } {
  const wantVision = messagesHaveImages(messages);
  if (!wantVision) {
    return { model: cfg.model, switchedToVision: false };
  }
  if (!cfg.visionModel) {
    throw new LLMError(
      null,
      'В сообщении есть картинка, но vision-модель не задана. ' +
        'Укажи VITE_LLM_VISION_MODEL (по умолчанию gemma3:4b) в .env, ' +
        'либо выбери vision-модель в Settings.',
    );
  }
  return { model: cfg.visionModel, switchedToVision: cfg.visionModel !== cfg.model };
}

/**
 * Стриминг ответа от LLM. Возвращает Promise<StreamResult> — резолвится,
 * когда стрим закончится (нормально / cancelled / error).
 *
 * Pulse v5.1: если в messages есть image — автоматически выберется visionModel
 * (если задан в env или localStorage). Vision-capable детектится эвристикой
 * по имени (gemma3 / llava / vision / vl / …) и через явный `visionModel` в
 * конфиге — всегда используем его при наличии картинки.
 *
 * @param req.messages        история диалога (system можно не передавать)
 * @param req.signal          AbortSignal — при abort() стрим отменяется
 * @param req.modelOverride   если задан — перебивает vision-авто-выбор
 * @param onChunk             колбэк на каждый пришедший кусочек текста
 */
export async function streamChat(
  req: ChatRequest,
  onChunk: StreamChunk,
): Promise<StreamResult> {
  const cfg = resolveConfig();
  if (!cfg.apiKey) {
    throw new LLMError(
      null,
      'API-ключ не задан. Создай .env (см. .env.example) и укажи VITE_LLM_API_KEY, ' +
        'затем перезапусти dev/build.',
    );
  }

  // Гарантируем, что system-промпт Pulse стоит первым.
  const hasSystem = req.messages.some((m) => m.role === 'system');
  const messages: LLMMessage[] = hasSystem ? req.messages : [PULSE_SYSTEM_PROMPT, ...req.messages];

  // Выбор модели. Если юзер явно override-нул через req.modelOverride — уважаем.
  // Иначе: есть image в messages → visionModel; иначе → text model.
  let modelToUse: string;
  let switchedToVision = false;
  if (req.modelOverride && req.modelOverride.trim()) {
    modelToUse = req.modelOverride;
    switchedToVision = messagesHaveImages(messages);
  } else {
    const r = resolveModelForMessages(cfg, messages);
    modelToUse = r.model;
    switchedToVision = r.switchedToVision;
  }

  // R89: дёргаем engine_decide ПАРАЛЛЕЛЬНО с fetch. Решение нужно только
  // ПОСЛЕ стрима (для UI chip'а), поэтому не блокирует первый chunk.
  // На web/mobile — мгновенный no-op (engineDecide возвращает default).
  // На Tauri — IPC roundtrip к Rust Smart Engine (~5ms).
  //
  // Берём текст ПОСЛЕДНЕГО user-сообщения — это то, что auto_prefer
  // реально анализирует (маркеры кода, длина, Russian verbs).
  const lastUserText = extractLastUserText(messages);
  const hasImage = messagesHaveImages(messages);
  const routingP = engineDecide(lastUserText, modelToUse, hasImage, '').catch(
    // engine_decide не критичен для chat'а — если сломан (нет Tauri,
    // ошибка IPC, таймаут), чип просто не покажется. Никогда не throw'им
    // в streamChat.
    () => undefined,
  );

  const body = {
    model: modelToUse,
    messages,
    temperature: req.temperature ?? 0.7,
    max_tokens: req.maxTokens ?? 1024,
    stream: true,
  };

  const url = `${cfg.baseUrl}/chat/completions`;
  let resp: Response;
  try {
    resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: req.signal,
    });
  } catch (e) {
    if (req.signal?.aborted) {
      return { text: '', finishReason: 'cancelled', usedModel: modelToUse };
    }
    throw new LLMError(null, `Сеть: ${(e as Error).message}. Проверь интернет.`);
  }

  if (!resp.ok) {
    let detail = '';
    try {
      detail = await resp.text();
    } catch {
      /* ignore */
    }
    if (resp.status === 401) {
      throw new LLMError(401, 'Неверный API-ключ (401). Проверь VITE_LLM_API_KEY в .env.');
    }
    if (resp.status === 404) {
      // Часто: модель не скачана. Ollama на /v1/chat/completions возвращает 404
      // с телом типа `{"error":"model \"gemma3:4b\" not found"}`.
      const hint = switchedToVision
        ? `Vision-модель «${modelToUse}» не найдена в Ollama. ` +
          'Скачай: ollama pull gemma3:4b (или укажи VITE_LLM_VISION_MODEL).'
        : `Модель «${modelToUse}» не найдена в Ollama. Скачай: ollama pull ${modelToUse}.`;
      throw new LLMError(404, hint);
    }
    if (resp.status === 429) {
      throw new LLMError(429, 'Rate limit (429). Подожди немного и попробуй снова.');
    }
    throw new LLMError(
      resp.status,
      `LLM вернул ${resp.status}. ${detail.slice(0, 200)}`.trim(),
    );
  }

  if (!resp.body) {
    throw new LLMError(null, 'Пустой ответ от LLM (нет body).');
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let text = '';

  // R89 helper: ждём routing decision (или no-op) и собираем финальный
  // StreamResult. Таймаут 200ms — на мобильном/web engineDecide no-op
  // мгновенный, на Tauri обычно < 10ms; 200ms это safety net для
  // зависшего IPC.
  const buildResult = async (
    finishReason: 'stop' | 'length' | 'cancelled' | 'error',
    finalText: string,
    errMsg?: string,
  ): Promise<StreamResult> => {
    const routing = await Promise.race([
      routingP,
      new Promise<undefined>((r) => setTimeout(() => r(undefined), 200)),
    ]);
    const r: StreamResult = {
      text: finalText,
      finishReason,
      usedModel: modelToUse,
    };
    if (routing) {
      r.routing = routing;
      r.routingMode = routingModeFor(routing.preferredModel);
    }
    if (errMsg) r.error = errMsg;
    return r;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSEChunk(buffer);
      buffer = rest;
      for (const ev of events) {
        for (const choice of ev.choices ?? []) {
          const delta = choice.delta?.content;
          if (delta) {
            text += delta;
            onChunk(delta);
          }
          if (choice.finish_reason === 'length') {
            return await buildResult('length', text);
          }
        }
      }
    }
    return await buildResult('stop', text);
  } catch (e) {
    if (req.signal?.aborted) {
      return await buildResult('cancelled', text);
    }
    throw new LLMError(null, `Стрим оборвался: ${(e as Error).message}`);
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/**
 * R89: извлечь текст последнего user-сообщения из history для engine_decide.
 * Smart Engine v3 анализирует именно последний user-message (маркеры кода,
 * длина, Russian edit verbs) — не всю историю.
 *
 * @param messages  массив LLMMessage (включая system)
 * @returns         текст последнего user-message, или '' если нет user'а
 */
function extractLastUserText(messages: LLMMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    // content — массив ContentPart. Берём первый text-блок.
    for (const part of m.content) {
      if (part.type === 'text') return part.text;
    }
    return '';
  }
  return '';
}

// ─── Vision capability detection (для UI badge) ───────────────────────────

/** Текущая активная text-модель (с учётом override). */
export function getActiveTextModel(): string {
  return resolveConfig().model;
}

/** Текущая активная vision-модель (с учётом override). */
export function getActiveVisionModel(): string {
  return resolveConfig().visionModel;
}

/** Будет ли vision-выбран, если в messages добавить картинку? */
export function isVisionAvailable(): boolean {
  return Boolean(resolveConfig().visionModel);
}

/** Capability badge для конкретной модели (по имени). */
export function capabilitiesOf(model: string): ModelCapabilities {
  return getModelCapabilities(model);
}
