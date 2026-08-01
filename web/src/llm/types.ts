// Типы для LLM-клиента. Поставщик-агностик: один и тот же набор типов
// подходит и для OpenAI, и для OpenRouter / Anthropic-compatible endpoint.
//
// Pulse v5.1 — multimodal (vision):
// `LLMMessage.content` теперь может быть либо строкой, либо массивом
// content-блоков в OpenAI-стиле (text + image_url). Ollama /v1/chat/completions
// принимает тот же формат и сам разворачивает image_url → `images: [base64]`
// для совместимости с нативным API. Vision-capable модели (gemma3:4b,
// llava, llama3.2-vision) понимают это «из коробки».
// Для моделей без vision фронт НЕ шлёт массив — fallback на текстовое
// описание картинки (см. `client.ts:resolveModelForMessages`).

export type Role = 'system' | 'user' | 'assistant';

/** OpenAI-style text block. */
export interface TextContentPart {
  type: 'text';
  text: string;
}

/** OpenAI-style image block. `url` ожидается data: URL (`data:image/...;base64,...`). */
export interface ImageUrlContentPart {
  type: 'image_url';
  image_url: {
    url: string;
    /** опц. детальность для OpenAI: 'low' | 'high' | 'auto'. Ollama игнорирует. */
    detail?: 'low' | 'high' | 'auto';
  };
}

export type ContentPart = TextContentPart | ImageUrlContentPart;

/** Одно сообщение в диалоге. `content` — строка (text-only) или массив блоков (multimodal). */
export interface LLMMessage {
  role: Role;
  content: string | ContentPart[];
}

/** Параметры запроса к LLM. */
export interface ChatRequest {
  /** История диалога: первым обычно идёт system. */
  messages: LLMMessage[];
  /** Температура (0..2). По умолчанию 0.7. */
  temperature?: number;
  /** Лимит токенов в ответе. */
  maxTokens?: number;
  /** Отменятор (AbortController.signal). Если задан — стрим можно прервать. */
  signal?: AbortSignal;
  /**
   * Если задан — перебивает выбор модели из env/localStorage.
   * Используется для ad-hoc прогонов с конкретной vision-моделью.
   */
  modelOverride?: string;
}

/** Колбэк на каждый пришедший чанк текста. */
export type StreamChunk = (delta: string) => void;

/** Решение Smart Engine v3 (R86/R89). Тип живёт в `route.ts`, тут
 *  re-export'им чтобы StreamResult мог его использовать без циклических
 *  импортов. Сам импорт type-only (см. import ниже). */
import type { EngineDecision, RoutingMode } from './route';

/** Финальный результат стрима: полный накопленный текст + причина завершения. */
export interface StreamResult {
  /** Весь текст, собранный из дельт. */
  text: string;
  /** Почему стрим закончился. */
  finishReason: 'stop' | 'length' | 'cancelled' | 'error';
  /** Сообщение об ошибке (если finishReason === 'error'). */
  error?: string;
  /** Какая модель реально была использована (после vision-выбора). */
  usedModel?: string;
  /** R89: routing decision от Smart Engine v3. Если `lowConfidence=true` —
   *  ChatView должен показать chip с override-опциями. Может быть undefined
   *  если engine_decide не сработал (нет Tauri / ошибка / cancelled). */
  routing?: EngineDecision;
  /** R89: human-readable routing mode ("CodeEdit" | "Vision" | ...). */
  routingMode?: RoutingMode;
}

// ─── Vision helpers ───────────────────────────────────────────────────────

/** True если content — массив и в нём есть image_url блок. */
export function hasImageContent(content: string | ContentPart[]): boolean {
  if (typeof content === 'string') return false;
  return content.some((p) => p.type === 'image_url');
}

/** True если в messages есть хотя бы один user-message с картинкой. */
export function messagesHaveImages(messages: LLMMessage[]): boolean {
  return messages.some((m) => m.role === 'user' && hasImageContent(m.content));
}

/**
 * Распознанные capabilities модели. Используется UI (badge "🖼️ vision")
 * и client'ом для выбора между text/vision моделью при наличии картинки.
 *
 * Эвристика по имени модели: спец. имена → vision, иначе text.
 * Можно расширить через lookup-таблицу в `models.ts` (Phase 5 — Settings).
 */
export interface ModelCapabilities {
  /** модель понимает картинки (image_url content blocks) */
  vision: boolean;
  /** модель поддерживает tool-use (нативный OpenAI tools, не JSON-mode) */
  tools: boolean;
}
