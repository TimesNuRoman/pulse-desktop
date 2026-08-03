// SPDX-License-Identifier: Apache-2.0
//
// Agent v3.1 — основной loop с retry / budget / telemetry.
//
// Алгоритм:
//   1. Вызываем `streamFn(messages, { model, signal })` — это обёртка над
//      `streamChat`, которая в текстовом ответе парсит блоки
//      `<tool_call>{"name":"...","arguments":{...}}</tool_call>`.
//   2. `streamFn` обёрнут в `retryWithBackoff` (retriable: network / 5xx /
//      timeout). Budget и abort — НЕ retriable.
//   3. Если в ответе есть tool_calls — инкрементируем budget.toolCalls,
//      выполняем каждый через `tool.execute(...)`, добавляем результат
//      в messages как user-role сообщение, и повторяем шаг 1.
//   4. Если ответ text-only — возвращаем финальный AgentLoopResult.
//   5. Если budget превышен — кидаем BudgetExceededError (без retry).
//   6. Если abortSignal.aborted — кидаем DOMException AbortError.
//
// Подключение из UI (например, ChatView useEffect):
//
//   const telemetry = new AgentTelemetry();
//   const result = await runAgentLoop({
//     messages,
//     tools: [webSearchTool, calcTool],
//     model: 'gemma3:4b',
//     telemetry,
//     abortSignal: ctrl.signal,
//     onTextDelta: (d) => appendToStream(d),
//     onToolCall: (tc) => log('tool', tc.name, tc.args),
//   });
//   // result.telemetry → для UI devtools
//   // result.toolCalls → для audit log
//
// В тестах `streamFn` подменяется на mock, чтобы не дёргать реальный LLM.

import { streamChat, type LLMError } from './client';
import type { LLMMessage, StreamResult } from './types';
import {
  retryWithBackoff,
  defaultIsRetriable,
  type RetryOpts,
} from '../lib/agentRetry';
import { AgentBudget, BudgetExceededError, type AgentBudgetOpts } from '../lib/agentBudget';
import { AgentTelemetry } from '../lib/agentTelemetry';

// ─── Public types ──────────────────────────────────────────────────────────

/** Один вызов инструмента внутри loop'а. */
export interface ToolCall {
  /** Уникальный id (генерируем внутри loop'а). */
  id: string;
  /** Имя инструмента (должно совпадать с AgentTool.name). */
  name: string;
  /** Аргументы после парсинга. */
  args: Record<string, unknown>;
  /** Результат execute, если успешно. */
  result?: unknown;
  /** Текст ошибки, если execute кинул. */
  error?: string;
  /** Сколько мс занял execute. */
  durationMs?: number;
}

/** Описание инструмента, доступного loop'у. */
export interface AgentTool {
  name: string;
  description: string;
  /** ZodSchema или JSONSchema-like. Тип `any` намеренно: парсер
   *  валидирует на стороне execute(). */
  parameters: unknown;
  execute: (args: any) => Promise<any>;
}

/** Расширенный результат стрима: текст + (опц.) распарсенные tool_calls. */
export interface StreamWithToolsResult {
  text: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>;
  /** Кол-во токенов (если провайдер прислал usage). */
  tokensUsed?: number;
}

/** Функция стрима. Дефолт — обёртка над `streamChat`. Можно подменить
 *  в тестах через `opts.streamFn`. */
export type StreamFn = (
  messages: LLMMessage[],
  opts: { model: string; signal?: AbortSignal; onTextDelta?: (delta: string) => void },
) => Promise<StreamWithToolsResult>;

export interface AgentLoopOpts {
  /** История диалога (включая system). Копируется, не мутируется. */
  messages: LLMMessage[];
  /** Доступные инструменты. Если пусто — model может вернуть только text. */
  tools: AgentTool[];
  /** Модель: gemma3:4b / qwen2.5:3b / и т.п. Передаётся как modelOverride. */
  model: string;
  /** Лимиты бюджета (опц.). */
  budget?: Partial<AgentBudgetOpts>;
  /** Retry-настройки (опц.). */
  retry?: Partial<RetryOpts>;
  /** Готовый telemetry-объект (опц.). По умолчанию создаётся новый. */
  telemetry?: AgentTelemetry;
  /** AbortSignal — отменяет loop. */
  abortSignal?: AbortSignal;
  /** Колбэк на каждый tool_call (ДО execute). */
  onToolCall?: (call: ToolCall) => void;
  /** Колбэк на каждый text delta. */
  onTextDelta?: (delta: string) => void;
  /** Подменить streamFn (для тестов). */
  streamFn?: StreamFn;
}

export interface AgentLoopResult {
  /** Финальное assistant-сообщение (text-only). */
  finalMessage: LLMMessage;
  /** Все выполненные tool_calls (по порядку). */
  toolCalls: ToolCall[];
  /** Сколько ходов model→tool→model заняло. */
  turns: number;
  /** Сколько токенов прислал провайдер (накопленно). */
  tokensUsed: number;
  /** Snapshot telemetry. */
  telemetry: ReturnType<AgentTelemetry['snapshot']>;
}

// ─── Tool-call marker parser ──────────────────────────────────────────────

/** Регулярка для извлечения `<tool_call>{...}</tool_call>` из текста.
 *  Жадная по содержимому, но не по блокам — `[^\x00]*?` ленивый, чтобы
 *  захватить только до первого `</tool_call>`. */
const TOOL_CALL_REGEX = /<tool_call>([\s\S]*?)<\/tool_call>/g;

/** Извлечь tool_calls из текста ответа модели. Блоки невалидного
 *  JSON-формата молча игнорируются (модель может сгенерировать мусор —
 *  это нормально в v3.1, не считаем ошибкой loop'а). */
export function parseToolCalls(text: string): Array<{ name: string; args: Record<string, unknown> }> {
  const out: Array<{ name: string; args: Record<string, unknown> }> = [];
  let m: RegExpExecArray | null;
  TOOL_CALL_REGEX.lastIndex = 0;
  while ((m = TOOL_CALL_REGEX.exec(text)) !== null) {
    const raw = m[1].trim();
    try {
      const parsed = JSON.parse(raw) as { name?: unknown; arguments?: unknown };
      if (typeof parsed.name !== 'string' || !parsed.name) continue;
      const args = (parsed.arguments && typeof parsed.arguments === 'object')
        ? (parsed.arguments as Record<string, unknown>)
        : {};
      out.push({ name: parsed.name, args });
    } catch {
      // Мусор в tool_call-блоке — пропускаем, остальной текст остаётся.
    }
  }
  return out;
}

/** Вырезать tool_call-блоки из текста, оставив только человекочитаемую
 *  часть (которую увидит пользователь). */
export function stripToolCalls(text: string): string {
  return text.replace(TOOL_CALL_REGEX, '').trim();
}

// ─── Default streamFn ─────────────────────────────────────────────────────

/** Реальный streamFn: зовёт `streamChat` и парсит tool_calls из текста. */
export const defaultStreamFn: StreamFn = async (
  messages,
  { model, signal, onTextDelta },
) => {
  const collected: string[] = [];
  const onChunk = (delta: string) => {
    collected.push(delta);
    if (onTextDelta) onTextDelta(delta);
  };
  let result: StreamResult;
  try {
    result = await streamChat({ messages, modelOverride: model, signal }, onChunk);
  } catch (e) {
    // streamChat выбрасывает LLMError — пробрасываем как есть. Retry-классификатор
    // разберётся, retriable это или нет.
    throw e;
  }
  const text = collected.join('');
  const toolCalls = parseToolCalls(text);
  return {
    text: stripToolCalls(text),
    toolCalls,
  };
};

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Главный entry point agent loop'а. Возвращает финальный результат
 * или кидает (BudgetExceededError / AbortError / LLMError / Error).
 *
 * @throws BudgetExceededError если счётчики превысили лимиты.
 * @throws DOMException('AbortError') при отмене через abortSignal.
 * @throws LLMError или другая ошибка stream'а (после retry-цикла).
 */
export async function runAgentLoop(opts: AgentLoopOpts): Promise<AgentLoopResult> {
  // ─── Defensive validation ─────────────────────────────────────────────
  if (!Array.isArray(opts.messages)) {
    throw new Error('runAgentLoop: opts.messages must be an array');
  }
  if (opts.messages.length === 0) {
    throw new Error('runAgentLoop: opts.messages must not be empty');
  }
  if (!opts.model || typeof opts.model !== 'string') {
    throw new Error('runAgentLoop: opts.model is required');
  }
  if (!Array.isArray(opts.tools)) {
    throw new Error('runAgentLoop: opts.tools must be an array');
  }

  const telemetry = opts.telemetry ?? new AgentTelemetry();
  const budget = new AgentBudget(opts.budget ?? {});
  const streamFn: StreamFn = opts.streamFn ?? defaultStreamFn;
  const toolMap = new Map<string, AgentTool>();
  for (const t of opts.tools) toolMap.set(t.name, t);

  // Локальная копия messages — не мутируем входной массив.
  const messages: LLMMessage[] = [...opts.messages];

  const allToolCalls: ToolCall[] = [];
  let turns = 0;
  let tokensUsed = 0;
  let nextId = 1;

  // ─── Main loop ────────────────────────────────────────────────────────
  while (true) {
    if (opts.abortSignal?.aborted) {
      throw new DOMException('Aborted', 'AbortError');
    }

    // Step 1: stream с retry. budget/abort — НЕ retriable.
    const streamAttempt = await retryWithBackoff(
      async () => streamFn(messages, {
        model: opts.model,
        signal: opts.abortSignal,
        onTextDelta: opts.onTextDelta,
      }),
      {
        isRetriable: defaultIsRetriable,
        ...(opts.retry ?? {}),
        onRetry: (attempt, delayMs, err) => {
          telemetry.recordEvent('agent.retry', { attempt, delayMs });
          if (opts.retry?.onRetry) opts.retry.onRetry(attempt, delayMs, err);
        },
      },
    );

    telemetry.recordEvent('agent.turn', { turn: turns + 1 });
    turns += 1;
    budget.recordTurn();

    if (streamAttempt.tokensUsed) {
      budget.recordTokens(streamAttempt.tokensUsed);
      tokensUsed += streamAttempt.tokensUsed;
      telemetry.recordLatency('agent.tokens', streamAttempt.tokensUsed);
    }

    // Step 2: tool_calls?
    if (streamAttempt.toolCalls.length > 0) {
      // Добавляем assistant-сообщение (text, без tool_call-блоков).
      if (streamAttempt.text) {
        messages.push({ role: 'assistant', content: streamAttempt.text });
      }
      // Выполняем каждый tool.
      for (const tc of streamAttempt.toolCalls) {
        const toolCall: ToolCall = {
          id: `tc_${nextId++}`,
          name: tc.name,
          args: tc.args,
        };
        allToolCalls.push(toolCall);
        if (opts.onToolCall) opts.onToolCall(toolCall);

        budget.recordToolCall();
        telemetry.recordEvent('agent.tool.start', { name: tc.name });

        const tool = toolMap.get(tc.name);
        const t0 = Date.now();
        if (!tool) {
          toolCall.error = `Unknown tool: ${tc.name}`;
          telemetry.recordError('agent.tool', new Error(toolCall.error));
        } else {
          try {
            const r = await tool.execute(tc.args);
            toolCall.result = r;
            telemetry.recordEvent('agent.tool.end', {
              name: tc.name,
              status: 'ok',
            });
          } catch (e) {
            const err = e instanceof Error ? e : new Error(String(e));
            toolCall.error = err.message;
            telemetry.recordError('agent.tool', err);
            telemetry.recordEvent('agent.tool.end', {
              name: tc.name,
              status: 'error',
            });
          }
        }
        toolCall.durationMs = Date.now() - t0;
        telemetry.recordLatency(`agent.tool.${tc.name}`, toolCall.durationMs);

        // Добавляем результат в messages как user-role (для простоты —
        // модели проще читать user-сообщения, чем tool-role). Формат
        // простой, не пытаемся быть OpenAI-compatible: модель видит
        // обёрнутый в `<tool_call>_result` блок.
        const resultBlock = toolCall.error
          ? `<tool_call>_result name="${tc.name}" error="true">\n${toolCall.error}\n</tool_call_result>`
          : `<tool_call>_result name="${tc.name}">\n${formatResult(toolCall.result)}\n</tool_call_result>`;
        messages.push({ role: 'user', content: resultBlock });
      }
      // Цикл: снова stream с обновлённой историей.
      continue;
    }

    // Step 3: text-only — финальный ответ.
    const finalMessage: LLMMessage = { role: 'assistant', content: streamAttempt.text };
    messages.push(finalMessage);
    telemetry.recordEvent('agent.done', { turns, toolCalls: allToolCalls.length });
    return {
      finalMessage,
      toolCalls: allToolCalls,
      turns,
      tokensUsed,
      telemetry: telemetry.snapshot(),
    };
  }
}

// ─── helpers ──────────────────────────────────────────────────────────────

/** Стрингифицировать результат tool'а для подстановки в messages. */
function formatResult(r: unknown): string {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  try {
    return JSON.stringify(r, null, 2);
  } catch {
    return String(r);
  }
}

// ─── Re-exports для удобства потребителей ────────────────────────────────

export { AgentBudget, BudgetExceededError } from '../lib/agentBudget';
export { AgentTelemetry } from '../lib/agentTelemetry';
export { retryWithBackoff, defaultIsRetriable } from '../lib/agentRetry';
export type { RetryOpts } from '../lib/agentRetry';
export type { AgentBudgetOpts, BudgetSnapshot } from '../lib/agentBudget';
// Тип из client.ts — re-export для удобства, чтобы не таскать 2 импорта.
export type { LLMError } from './client';
