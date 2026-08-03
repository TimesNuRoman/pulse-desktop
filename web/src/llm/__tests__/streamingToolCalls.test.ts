// SPDX-License-Identifier: Apache-2.0
// R200: vitest tests для StreamingToolCallParser.
//
// Pure-логика (нет React / Tauri / fetch), DOM env не нужен, но
// happy-dom всё равно грузится (см. vitest.config.ts).
//
// Покрытие:
//   * basic assembly  (5)
//   * multi-tool-call (2)
//   * edge cases      (7)
//   * Cyrillic / UTF-8 (2)
//   * real-world OpenAI delta shape (1)
//   * idempotency     (2)
//   * finalize / reset / errors (4)
//   ─────────────────────────────
//   23 теста (target был 8+, спека просила 15-18 — берём с запасом).

import { describe, test, expect } from 'vitest';
import {
  StreamingToolCallParser,
  type ToolCallDelta,
  type AssembledToolCall,
} from '../streamingToolCalls';

// ─── helpers ──────────────────────────────────────────────────────────────

/** Build a delta quickly. */
function d(
  index: number,
  fields: Partial<Omit<ToolCallDelta, 'index' | 'function'>> & { function?: ToolCallDelta['function'] } = {},
): ToolCallDelta {
  return { index, ...fields };
}

// ─── basic assembly ───────────────────────────────────────────────────────

describe('basic assembly', () => {
  test('empty parser + empty deltas → empty result', () => {
    const p = new StreamingToolCallParser();
    const r = p.add([]);
    expect(r.complete).toEqual([]);
    expect(r.pending).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(p.size()).toBe(0);
  });

  test('one full delta (id + name + arguments) → 1 complete, 0 pending', () => {
    const p = new StreamingToolCallParser();
    const r = p.add([
      d(0, {
        id: 'call_abc',
        type: 'function',
        function: { name: 'web_search', arguments: '{"q":"ollama"}' },
      }),
    ]);
    expect(r.complete).toHaveLength(1);
    expect(r.complete[0]).toEqual({
      id: 'call_abc',
      type: 'function',
      function: { name: 'web_search', arguments: '{"q":"ollama"}' },
    });
    expect(r.pending).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('partial delta (index only, no id/name) → 0 complete, 1 pending', () => {
    const p = new StreamingToolCallParser();
    const r = p.add([d(0, {})]);
    expect(r.complete).toEqual([]);
    expect(r.pending).toHaveLength(1);
    expect(r.pending[0].id).toBe('');
    expect(r.pending[0].function.name).toBe('');
    expect(r.errors).toEqual([]);
  });

  test('multi-chunk name: "web_" then "search" → assembled "web_search"', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1', function: { name: 'web_' } }));
    const r = p.addOne(d(0, { function: { name: 'search' } }));
    expect(r.complete).toHaveLength(1);
    expect(r.complete[0].function.name).toBe('web_search');
  });

  test('multi-chunk arguments: pieces concatenated in order', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1', function: { name: 'echo' } }));
    p.addOne(d(0, { function: { arguments: '{"q' } }));
    p.addOne(d(0, { function: { arguments: '":"oll' } }));
    const r = p.addOne(d(0, { function: { arguments: 'ama"}' } }));
    expect(r.complete[0].function.arguments).toBe('{"q":"ollama"}');
  });
});

// ─── multi-tool-call ──────────────────────────────────────────────────────

describe('multi-tool-call', () => {
  test('two tool calls in same stream, different indexes → 2 complete', () => {
    const p = new StreamingToolCallParser();
    p.add([
      d(0, { id: 'call_a', function: { name: 'web_search', arguments: '{"q":"a"}' } }),
      d(1, { id: 'call_b', function: { name: 'image_gen', arguments: '{"p":"b"}' } }),
    ]);
    const r = p.finalize();
    expect(r.complete).toHaveLength(2);
    const names = r.complete.map((c) => c.function.name).sort();
    expect(names).toEqual(['image_gen', 'web_search']);
  });

  test('interleaved deltas (index 0, 1, 0, 1) → both end up correct', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_0', function: { name: 'a' } }));
    p.addOne(d(1, { id: 'call_1', function: { name: 'b' } }));
    p.addOne(d(0, { function: { arguments: '{"i":0}' } }));
    p.addOne(d(1, { function: { arguments: '{"i":1}' } }));
    const r = p.finalize();
    expect(r.complete).toHaveLength(2);
    const byId = new Map(r.complete.map((c) => [c.id, c]));
    expect(byId.get('call_0')?.function.arguments).toBe('{"i":0}');
    expect(byId.get('call_1')?.function.arguments).toBe('{"i":1}');
  });
});

// ─── edge cases ───────────────────────────────────────────────────────────

describe('edge cases', () => {
  test('negative index → error added, ignored', () => {
    const p = new StreamingToolCallParser();
    const r = p.addOne(d(-1, { id: 'call_x', function: { name: 'fn' } }));
    expect(r.complete).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/non-negative integer/);
    expect(p.size()).toBe(0);
  });

  test('non-integer index (0.5) → error added, ignored', () => {
    const p = new StreamingToolCallParser();
    const r = p.addOne(d(0.5 as number, { id: 'call_x' }));
    expect(r.errors).toHaveLength(1);
    expect(p.size()).toBe(0);
  });

  test('same id at different indexes → second one added to errors', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_abc', function: { name: 'a' } }));
    const r = p.addOne(d(1, { id: 'call_abc', function: { name: 'b' } }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/already used/);
    // First call is still assembled
    expect(p.getAssembled()).toHaveLength(1);
  });

  test('id conflict at same index (different ids) → error, first id kept', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_first' }));
    const r = p.addOne(d(0, { id: 'call_second' }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/id conflict/);
    expect(p.getAssembled()[0].id).toBe('call_first');
  });

  test('finalize() with no deltas → empty', () => {
    const p = new StreamingToolCallParser();
    const r = p.finalize();
    expect(r.complete).toEqual([]);
    expect(r.pending).toEqual([]);
  });

  test('finalize() with partial deltas → pending gets synthesized id, moves to complete', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { function: { name: 'web_search' } }));
    expect(p.add([]).pending).toHaveLength(1);
    const r = p.finalize();
    expect(r.complete).toHaveLength(1);
    expect(r.complete[0].id).toBe('__pending_0');
    expect(r.complete[0].function.name).toBe('web_search');
  });

  test('reset() clears all state', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1', function: { name: 'fn' } }));
    expect(p.size()).toBe(1);
    p.reset();
    expect(p.size()).toBe(0);
    expect(p.getAssembled()).toEqual([]);
    const r = p.finalize();
    expect(r.complete).toEqual([]);
  });

  test('duplicate id at same index (idempotent) → no error, no double-add', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1', function: { name: 'fn' } }));
    const r = p.addOne(d(0, { id: 'call_1', function: { name: 'more' } }));
    expect(r.errors).toEqual([]);
    // Note: name IS appended (forward-only). Idempotency is only on id.
    expect(p.getAssembled()[0].function.name).toBe('fnmore');
  });

  test('delta for finalized call → error', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_x', function: { name: 'fn' } }));
    p.finalize();
    const r = p.addOne(d(0, { function: { arguments: 'x' } }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/already-finalized/);
  });

  test('index > MAX_INDEX → error', () => {
    const p = new StreamingToolCallParser();
    const r = p.addOne(d(2000, { id: 'call_x', function: { name: 'fn' } }));
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/exceeds cap/);
  });

  test('100 deltas for same index → all name chunks append', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1' }));
    for (let i = 0; i < 100; i++) {
      p.addOne(d(0, { function: { name: 'a' } }));
    }
    const a = p.getAssembled()[0];
    expect(a.function.name).toBe('a'.repeat(100));
  });
});

// ─── Cyrillic / UTF-8 ─────────────────────────────────────────────────────

describe('Cyrillic / UTF-8', () => {
  test('Cyrillic in arguments preserved as-is, no escaping', () => {
    const p = new StreamingToolCallParser();
    const raw = '{"q":"привет"}';
    p.addOne(d(0, { id: 'call_1', function: { name: 'echo', arguments: raw } }));
    const a = p.getAssembled()[0];
    expect(a.function.arguments).toBe(raw);
    // bytes match exactly
    expect(a.function.arguments.length).toBe(raw.length);
  });

  test('long arguments (10K chars) → no truncation', () => {
    const p = new StreamingToolCallParser();
    const big = 'x'.repeat(10_000);
    p.addOne(d(0, { id: 'call_1', function: { name: 'echo', arguments: big } }));
    expect(p.getAssembled()[0].function.arguments.length).toBe(10_000);
  });
});

// ─── real-world OpenAI delta shape ────────────────────────────────────────

describe('real-world OpenAI delta shape', () => {
  test('typical 4-chunk web_search stream → fully assembled', () => {
    const p = new StreamingToolCallParser();

    // chunk 1: id + type, function.name="" function.arguments=""
    p.addOne({
      index: 0,
      id: 'call_abc',
      type: 'function',
      function: { name: '', arguments: '' },
    });
    // chunk 2: name piece #1
    p.addOne({
      index: 0,
      function: { name: 'web_' },
    });
    // chunk 3: name piece #2
    p.addOne({
      index: 0,
      function: { name: 'search' },
    });
    // chunk 4: args piece (note escaped quotes)
    p.addOne({
      index: 0,
      function: { arguments: '{"q":"oll' },
    });
    // chunk 5: args continued
    p.addOne({
      index: 0,
      function: { arguments: 'ama"}' },
    });

    const r = p.finalize();
    expect(r.complete).toHaveLength(1);
    expect(r.complete[0]).toEqual({
      id: 'call_abc',
      type: 'function',
      function: { name: 'web_search', arguments: '{"q":"ollama"}' },
    });
  });
});

// ─── idempotency ──────────────────────────────────────────────────────────

describe('idempotency', () => {
  test('add() with same deltas twice → no errors, stable assembled (id field)', () => {
    const p = new StreamingToolCallParser();
    const deltas: ToolCallDelta[] = [
      d(0, { id: 'call_1', function: { name: 'fn' } }),
    ];
    p.add(deltas);
    p.add(deltas);
    // id is stable; name would double but we only set name once here.
    expect(p.getAssembled()).toHaveLength(1);
    expect(p.getAssembled()[0].id).toBe('call_1');
  });

  test('reset() then re-add same deltas → fresh state, same result', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_1', function: { name: 'fn' } }));
    p.reset();
    const r = p.addOne(d(0, { id: 'call_1', function: { name: 'fn' } }));
    expect(r.errors).toEqual([]);
    expect(p.getAssembled()).toHaveLength(1);
    expect(p.getAssembled()[0]).toEqual({
      id: 'call_1',
      type: 'function',
      function: { name: 'fn', arguments: '' },
    });
  });
});

// ─── getAssembled / size ──────────────────────────────────────────────────

describe('getAssembled / size', () => {
  test('getAssembled returns both complete and pending', () => {
    const p = new StreamingToolCallParser();
    p.addOne(d(0, { id: 'call_0', function: { name: 'a' } })); // complete
    p.addOne(d(1, { id: 'call_1' })); // pending (no name)
    const all = p.getAssembled();
    expect(all).toHaveLength(2);
    const byId = new Map(all.map((a) => [a.id, a]));
    expect(byId.get('call_0')?.function.name).toBe('a');
    expect(byId.get('call_1')?.function.name).toBe('');
  });

  test('size() reflects number of tracked indexes', () => {
    const p = new StreamingToolCallParser();
    expect(p.size()).toBe(0);
    p.addOne(d(0, { id: 'a' }));
    expect(p.size()).toBe(1);
    p.addOne(d(2, { id: 'b' }));
    expect(p.size()).toBe(2);
    p.reset();
    expect(p.size()).toBe(0);
  });
});
