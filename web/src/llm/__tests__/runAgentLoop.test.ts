// SPDX-License-Identifier: Apache-2.0
//
// R194 — vitest tests для `runAgentLoop.ts`.
//
// Все тесты подменяют `streamFn` через `opts.streamFn` (не мокаем модуль
// `client.ts` — это ломает happy-dom env). Mock'и возвращают canned
// `StreamWithToolsResult`. Реальный `streamChat` не дёргается.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  runAgentLoop,
  parseToolCalls,
  stripToolCalls,
  type StreamFn,
  type AgentTool,
} from '../runAgentLoop';
import { AgentTelemetry } from '../../lib/agentTelemetry';
import { BudgetExceededError } from '../../lib/agentBudget';
import { LLMError } from '../client';
import type { LLMMessage } from '../types';

// ─── helpers ──────────────────────────────────────────────────────────────

/** Создать streamFn, который последовательно возвращает canned results. */
function cannedStream(
  results: Array<{ text: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>,
): StreamFn {
  let i = 0;
  const fn = vi.fn(async (_messages: LLMMessage[]) => {
    const r = results[Math.min(i, results.length - 1)]!;
    i += 1;
    return { text: r.text, toolCalls: r.toolCalls ?? [] };
  });
  return fn as unknown as StreamFn;
}

const baseMessages: LLMMessage[] = [
  { role: 'system', content: 'You are helpful.' },
  { role: 'user', content: 'hi' },
];

const noopTools: AgentTool[] = [];

// ─── parseToolCalls / stripToolCalls (unit) ──────────────────────────────

describe('parseToolCalls', () => {
  test('extracts single tool_call block', () => {
    const text = 'ok before <tool_call>{"name":"web_search","arguments":{"q":"x"}}</tool_call> after';
    const tcs = parseToolCalls(text);
    expect(tcs).toEqual([{ name: 'web_search', args: { q: 'x' } }]);
  });

  test('extracts multiple tool_call blocks', () => {
    const text =
      '<tool_call>{"name":"a","arguments":{"x":1}}</tool_call> ' +
      'middle ' +
      '<tool_call>{"name":"b","arguments":{"y":2}}</tool_call>';
    const tcs = parseToolCalls(text);
    expect(tcs).toEqual([
      { name: 'a', args: { x: 1 } },
      { name: 'b', args: { y: 2 } },
    ]);
  });

  test('ignores invalid JSON', () => {
    const text = '<tool_call>{not valid json}</tool_call> tail';
    const tcs = parseToolCalls(text);
    expect(tcs).toEqual([]);
  });

  test('ignores blocks without name', () => {
    const text = '<tool_call>{"arguments":{"q":"x"}}</tool_call>';
    const tcs = parseToolCalls(text);
    expect(tcs).toEqual([]);
  });

  test('returns empty for text without markers', () => {
    expect(parseToolCalls('plain text')).toEqual([]);
  });

  test('handles multiline JSON', () => {
    const text = `before
<tool_call>{
  "name": "search",
  "arguments": {
    "query": "multi line"
  }
}</tool_call>
after`;
    const tcs = parseToolCalls(text);
    expect(tcs).toEqual([{ name: 'search', args: { query: 'multi line' } }]);
  });
});

describe('stripToolCalls', () => {
  test('removes tool_call blocks, keeps surrounding text', () => {
    const text = 'before <tool_call>{"name":"a"}</tool_call> after';
    expect(stripToolCalls(text)).toBe('before  after');
  });

  test('trims whitespace', () => {
    expect(stripToolCalls('  hello  ')).toBe('hello');
  });

  test('returns empty if only tool_calls', () => {
    const text = '<tool_call>{"name":"a","arguments":{}}</tool_call>';
    expect(stripToolCalls(text)).toBe('');
  });
});

// ─── runAgentLoop: happy paths ───────────────────────────────────────────

describe('runAgentLoop: text-only response', () => {
  test('returns final text after 1 turn, 0 tool calls', async () => {
    const stream = cannedStream([{ text: 'Hello back!' }]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      streamFn: stream,
    });
    expect(result.finalMessage).toEqual({ role: 'assistant', content: 'Hello back!' });
    expect(result.toolCalls).toEqual([]);
    expect(result.turns).toBe(1);
    expect(result.tokensUsed).toBe(0);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  test('forwards text deltas to onTextDelta callback', async () => {
    const onTextDelta = vi.fn();
    const stream = vi.fn(async () => {
      // Симулируем что streamFn вызывает onTextDelta (как делает defaultStreamFn).
      onTextDelta('Hi');
      onTextDelta(' there');
      return { text: 'Hi there', toolCalls: [] };
    }) as StreamFn;
    await runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      onTextDelta,
      streamFn: stream,
    });
    expect(onTextDelta).toHaveBeenCalledWith('Hi');
    expect(onTextDelta).toHaveBeenCalledWith(' there');
  });

  test('returns telemetry snapshot in result', async () => {
    const telemetry = new AgentTelemetry();
    const stream = cannedStream([{ text: 'ok' }]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      telemetry,
      streamFn: stream,
    });
    expect(result.telemetry).toBeDefined();
    expect(result.telemetry.totalEvents).toBeGreaterThan(0);
    // 'agent.turn' и 'agent.done' идут в recentEvents.
    const eventNames = result.telemetry.recentEvents.map((e) => e.name);
    expect(eventNames).toContain('agent.turn');
    expect(eventNames).toContain('agent.done');
  });
});

// ─── runAgentLoop: tool calls ───────────────────────────────────────────

describe('runAgentLoop: tool calls', () => {
  test('executes one tool call and continues to final text', async () => {
    const searchTool: AgentTool = {
      name: 'web_search',
      description: 'search the web',
      parameters: {},
      execute: vi.fn().mockResolvedValue('found 3 results'),
    };
    const stream = cannedStream([
      {
        text: 'Let me search.',
        toolCalls: [{ name: 'web_search', args: { q: 'weather' } }],
      },
      { text: 'Result: sunny' },
    ]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: [searchTool],
      model: 'gemma3:4b',
      streamFn: stream,
    });
    expect(searchTool.execute).toHaveBeenCalledWith({ q: 'weather' });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.name).toBe('web_search');
    expect(result.toolCalls[0]!.result).toBe('found 3 results');
    expect(result.toolCalls[0]!.error).toBeUndefined();
    expect(result.toolCalls[0]!.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.finalMessage.content).toBe('Result: sunny');
    expect(result.turns).toBe(2);
    expect(stream).toHaveBeenCalledTimes(2);
  });

  test('executes multiple tool calls in sequence (3 turns, 3 tool calls)', async () => {
    const toolA: AgentTool = { name: 'a', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('A result') };
    const toolB: AgentTool = { name: 'b', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('B result') };
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 'a', args: { n: 1 } }] },
      { text: '', toolCalls: [{ name: 'b', args: { n: 2 } }] },
      { text: '', toolCalls: [{ name: 'a', args: { n: 3 } }] },
      { text: 'all done' },
    ]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: [toolA, toolB],
      model: 'gemma3:4b',
      streamFn: stream,
    });
    expect(result.toolCalls).toHaveLength(3);
    expect(result.toolCalls[0]!.name).toBe('a');
    expect(result.toolCalls[1]!.name).toBe('b');
    expect(result.toolCalls[2]!.name).toBe('a');
    expect(result.turns).toBe(4);
    expect(toolA.execute).toHaveBeenCalledTimes(2);
    expect(toolB.execute).toHaveBeenCalledTimes(1);
  });

  test('records tool error in ToolCall.error and continues', async () => {
    const badTool: AgentTool = {
      name: 'failing',
      description: '',
      parameters: {},
      execute: vi.fn().mockRejectedValue(new Error('boom')),
    };
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 'failing', args: {} }] },
      { text: 'recovered' },
    ]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: [badTool],
      model: 'gemma3:4b',
      streamFn: stream,
    });
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0]!.error).toBe('boom');
    expect(result.toolCalls[0]!.result).toBeUndefined();
    expect(result.finalMessage.content).toBe('recovered');
  });

  test('unknown tool name produces error in ToolCall but loop continues', async () => {
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 'mystery', args: {} }] },
      { text: 'fallback text' },
    ]);
    const result = await runAgentLoop({
      messages: [...baseMessages],
      tools: [],
      model: 'gemma3:4b',
      streamFn: stream,
    });
    expect(result.toolCalls[0]!.error).toContain('Unknown tool');
    expect(result.finalMessage.content).toBe('fallback text');
  });

  test('onToolCall fires before each tool execution', async () => {
    const tool: AgentTool = { name: 't', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('r') };
    const onToolCall = vi.fn();
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 't', args: { x: 1 } }] },
      { text: 'done' },
    ]);
    await runAgentLoop({
      messages: [...baseMessages],
      tools: [tool],
      model: 'gemma3:4b',
      onToolCall,
      streamFn: stream,
    });
    expect(onToolCall).toHaveBeenCalledTimes(1);
    expect(onToolCall.mock.calls[0]![0].name).toBe('t');
    expect(onToolCall.mock.calls[0]![0].args).toEqual({ x: 1 });
  });
});

// ─── runAgentLoop: budget ───────────────────────────────────────────────

describe('runAgentLoop: budget', () => {
  test('throws BudgetExceededError when tool_calls exceed max', async () => {
    const tool: AgentTool = { name: 't', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('r') };
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: '', toolCalls: [{ name: 't', args: {} }] },
    ]);
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: [tool],
      model: 'gemma3:4b',
      budget: { maxToolCalls: 2 },
      streamFn: stream,
    });
    await expect(p).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(p).rejects.toMatchObject({ code: 'TOOL_CALLS' });
  });

  test('throws BudgetExceededError when turns exceed max', async () => {
    const tool: AgentTool = { name: 't', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('r') };
    // Каждый ход = tool_call → следующий stream. На 3-м ходу превышаем maxTurns=2.
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: '', toolCalls: [{ name: 't', args: {} }] },
    ]);
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: [tool],
      model: 'gemma3:4b',
      budget: { maxTurns: 2 },
      streamFn: stream,
    });
    await expect(p).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(p).rejects.toMatchObject({ code: 'TURNS' });
  });
});

// ─── runAgentLoop: retry ─────────────────────────────────────────────────

describe('runAgentLoop: retry on transient errors', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  test('retries on network error and succeeds on 2nd attempt', async () => {
    const err = new LLMError(null, 'network');
    let i = 0;
    const stream: StreamFn = vi.fn(async () => {
      i += 1;
      if (i === 1) throw err;
      return { text: 'success on retry', toolCalls: [] };
    });
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      retry: { maxAttempts: 3, baseDelayMs: 50, maxDelayMs: 200 },
      streamFn: stream,
    });
    // Проматываем fake-таймеры через возможные backoff'и.
    await vi.advanceTimersByTimeAsync(500);
    const result = await p;
    expect(result.finalMessage.content).toBe('success on retry');
    expect(stream).toHaveBeenCalledTimes(2);
  });

  test('does NOT retry on non-retriable error (401)', async () => {
    const err = new LLMError(401, 'unauthorized');
    const stream: StreamFn = vi.fn(async () => {
      throw err;
    });
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      retry: { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 200 },
      streamFn: stream,
    });
    await expect(p).rejects.toBe(err);
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

// ─── runAgentLoop: abort ─────────────────────────────────────────────────

describe('runAgentLoop: abort signal', () => {
  test('throws AbortError when signal already aborted', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    const stream = cannedStream([{ text: 'never called' }]);
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: noopTools,
      model: 'gemma3:4b',
      abortSignal: ctrl.signal,
      streamFn: stream,
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(stream).not.toHaveBeenCalled();
  });

  test('throws AbortError when signal aborts mid-loop', async () => {
    const ctrl = new AbortController();
    const tool: AgentTool = {
      name: 't',
      description: '',
      parameters: {},
      execute: vi.fn().mockImplementation(async () => {
        ctrl.abort();
        return 'r';
      }),
    };
    // 1-й ход: model вернёт tool_call → execute отработает и заабортит сигнал.
    // 2-й ход (продолжение) должен увидеть aborted и кинуть AbortError.
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: 'unreachable' },
    ]);
    const p = runAgentLoop({
      messages: [...baseMessages],
      tools: [tool],
      model: 'gemma3:4b',
      abortSignal: ctrl.signal,
      streamFn: stream,
    });
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    // stream должен быть вызван 1 раз — на 2-м ходу loop кидает до stream.
    expect(stream).toHaveBeenCalledTimes(1);
  });
});

// ─── runAgentLoop: defensive validation ──────────────────────────────────

describe('runAgentLoop: defensive validation', () => {
  test('throws on empty messages', async () => {
    const stream = cannedStream([]);
    await expect(
      runAgentLoop({
        messages: [],
        tools: noopTools,
        model: 'gemma3:4b',
        streamFn: stream,
      }),
    ).rejects.toThrow(/messages must not be empty/);
  });

  test('throws on missing model', async () => {
    const stream = cannedStream([]);
    await expect(
      runAgentLoop({
        messages: [...baseMessages],
        tools: noopTools,
        model: '' as string, // пустая строка пройдёт тип, но не runtime-проверку.
        streamFn: stream,
      }),
    ).rejects.toThrow(/model is required/);
  });
});

// ─── runAgentLoop: messages не мутируются ─────────────────────────────────

describe('runAgentLoop: input immutability', () => {
  test('does not mutate input messages array', async () => {
    const input: LLMMessage[] = [
      { role: 'user', content: 'hi' },
    ];
    const before = JSON.parse(JSON.stringify(input));
    const tool: AgentTool = { name: 't', description: '', parameters: {}, execute: vi.fn().mockResolvedValue('r') };
    const stream = cannedStream([
      { text: '', toolCalls: [{ name: 't', args: {} }] },
      { text: 'done' },
    ]);
    await runAgentLoop({
      messages: input,
      tools: [tool],
      model: 'gemma3:4b',
      streamFn: stream,
    });
    // Входной массив — тот же reference, тот же length, те же элементы.
    expect(input).toEqual(before);
    expect(input).toHaveLength(1);
  });
});
