// SPDX-License-Identifier: Apache-2.0
// R197 — vitest tests для ConversationMemory.
//
// Покрывает:
//   - estimateTokens (short / long / multimodal / empty / Cyrillic)
//   - basic add / get / clear / addMany
//   - sliding window (soft budget enforced, sync drop when no summarizer)
//   - hard budget (overflow → drop, throw если summarizer не задан и
//     дропать нечего)
//   - system message всегда pinned
//   - preserveRecentCount защищает хвост от дропа
//   - pinMessage / unpinMessage / getPinnedIndices
//   - summarizer (success / empty / throw / force-fallback) через compact()
//   - edge cases (soft=0, negative budget clamped, batch 1000, Cyrillic)
//   - MemoryOverflowError shape
//   - DEFAULT_MEMORY_CONFIG и defaults
//   - getStats
//
// Все тесты pure — никакого DOM, никакого clock'а, никакого I/O.

import { describe, test, expect } from 'vitest';
import {
  ConversationMemory,
  MemoryOverflowError,
  estimateTokens,
  estimateMessageTokens,
  DEFAULT_MEMORY_CONFIG,
  DEFAULT_IMAGE_TOKENS,
} from '../memory';
import type { LLMMessage, ContentPart } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Генерирует детерминированное ASCII-сообщение заданной длины. */
function asciiMessage(
  role: 'user' | 'assistant' | 'system',
  chars: number,
): LLMMessage {
  const body = 'x'.repeat(chars);
  return { role, content: body };
}

/** Cyrillic — каждый char занимает 1 UTF-16 code unit. */
function cyrillicMessage(role: 'user' | 'assistant', chars: number): LLMMessage {
  const unit = 'П';
  return { role, content: unit.repeat(chars) };
}

// ─── estimateTokens ───────────────────────────────────────────────────────

describe('estimateTokens', () => {
  test('short ASCII string: 10 chars / 4 = ceil(2.5) = 3 tokens', () => {
    const m = asciiMessage('user', 10);
    expect(estimateMessageTokens(m, 4, DEFAULT_IMAGE_TOKENS)).toBe(3);
  });

  test('long ASCII string: 4000 chars / 4 = 1000 tokens', () => {
    const m = asciiMessage('user', 4000);
    expect(estimateMessageTokens(m, 4, DEFAULT_IMAGE_TOKENS)).toBe(1000);
  });

  test('multimodal message: text + image costs text/4 + 765', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'a'.repeat(400) }, // 100 tokens
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } }, // 765 tokens
    ];
    const m: LLMMessage = { role: 'user', content: parts };
    expect(estimateMessageTokens(m, 4, DEFAULT_IMAGE_TOKENS)).toBe(100 + 765);
  });

  test('multimodal with two images: text + 2 * 765', () => {
    const parts: ContentPart[] = [
      { type: 'text', text: 'hi' }, // 1 token
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,BBB' } },
    ];
    const m: LLMMessage = { role: 'user', content: parts };
    expect(estimateMessageTokens(m, 4, DEFAULT_IMAGE_TOKENS)).toBe(1 + 2 * 765);
  });

  test('empty array → 0 tokens', () => {
    expect(estimateTokens([])).toBe(0);
  });

  test('sums across messages', () => {
    const msgs = [asciiMessage('user', 40), asciiMessage('assistant', 80)];
    // 10 + 20 = 30
    expect(estimateTokens(msgs, 4, DEFAULT_IMAGE_TOKENS)).toBe(30);
  });

  test('charsPerToken override: 1 → 1 token per char', () => {
    const m = asciiMessage('user', 7);
    expect(estimateMessageTokens(m, 1, DEFAULT_IMAGE_TOKENS)).toBe(7);
  });
});

// ─── ConversationMemory: basic ────────────────────────────────────────────

describe('ConversationMemory basic flow', () => {
  test('add then get returns the message', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'user', content: 'hello' });
    expect(mem.get()).toEqual([{ role: 'user', content: 'hello' }]);
  });

  test('add 3 messages → get returns all 3 in order', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'system', content: 'sys' });
    mem.add({ role: 'user', content: 'u1' });
    mem.add({ role: 'assistant', content: 'a1' });
    expect(mem.get().map((m) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
    ]);
  });

  test('clear empties everything', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'user', content: 'a' });
    mem.add({ role: 'user', content: 'b' });
    mem.clear();
    expect(mem.get()).toEqual([]);
    expect(mem.getStats().totalMessages).toBe(0);
  });

  test('empty conversation: get returns []', () => {
    const mem = new ConversationMemory();
    expect(mem.get()).toEqual([]);
  });

  test('only system message: get returns [system]', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'system', content: 'you are helpful' });
    expect(mem.get()).toEqual([{ role: 'system', content: 'you are helpful' }]);
  });

  test('addMany adds all in order (no summarizer → auto-trim)', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
    });
    mem.addMany([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
    ]);
    expect(mem.get().map((m) => m.content)).toEqual(['sys', 'a', 'b']);
  });

  test('addMany с summarizer: не триммит автоматически', () => {
    const summarizer = async () => 'sum';
    const mem = new ConversationMemory({
      softTokenBudget: 5,
      hardTokenBudget: 1000,
      summarizer,
    });
    mem.addMany([
      { role: 'user', content: 'a' },
      { role: 'user', content: 'b' },
      { role: 'user', content: 'c' },
    ]);
    // 3 сообщения — summarizer настроен, auto-trim не сработал
    expect(mem.get().length).toBe(3);
  });
});

// ─── Sliding window / soft budget (auto-trim без summarizer) ─────────────

describe('ConversationMemory sliding window (no summarizer)', () => {
  test('10 small messages all fit under soft 100 tokens', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 100,
      hardTokenBudget: 1000,
    });
    for (let i = 0; i < 10; i++) {
      mem.add({ role: 'user', content: `q${i}` }); // 2 chars = 1 token each
    }
    expect(mem.get().length).toBe(10);
  });

  test('soft budget enforced: drops oldest non-pinned (preserveRecentCount=0)', () => {
    // 5 × 10t = 50t, soft 25, preserveRecentCount=0
    // 50 > 25 → drop. head=[u1] droppable. 40 > 25. drop u2. 30 > 25. drop u3.
    // 20 ≤ 25, stop. 2 messages.
    const mem = new ConversationMemory({
      softTokenBudget: 25,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    for (let i = 0; i < 5; i++) {
      mem.add(asciiMessage('user', 40)); // 10 tokens each
    }
    expect(mem.get().length).toBe(2);
  });

  test('soft budget drops oldest one at a time until under', () => {
    // 4 × 10t = 40t, soft 50, hard 1000
    const mem = new ConversationMemory({
      softTokenBudget: 50,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    for (let i = 0; i < 4; i++) {
      mem.add(asciiMessage('user', 40));
    }
    // After 4: 40t ≤ 50 → ok, 4 messages
    expect(mem.get().length).toBe(4);
    mem.add(asciiMessage('user', 40));
    // 5th: 50t = 50, ≤ soft, ok, 5 messages
    expect(mem.get().length).toBe(5);
    mem.add(asciiMessage('user', 40));
    // 6th: 60t > 50. drop oldest. 50t = 50, stop. 5 messages
    expect(mem.get().length).toBe(5);
    expect(mem.getStats().droppedMessages).toBe(1);
  });

  test('system message preserved при sync drop over budget', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 20,
      hardTokenBudget: 30,
      preserveRecentCount: 0,
    });
    mem.add({ role: 'system', content: 'sys' }); // 1t (3/4 = 1)
    for (let i = 0; i < 5; i++) mem.add(asciiMessage('user', 40)); // 10t each
    // System должен остаться
    const visible = mem.get();
    expect(visible[0].role).toBe('system');
    expect(visible[0].content).toBe('sys');
  });

  test('preserveRecentCount защищает хвост от дропа', () => {
    // 5 × 10t = 50t, soft 25, preserveRecentCount=2
    // Last 2 pinned-implicit. head=[u1,u2,u3] (3 droppable, since 4,5 implicit).
    // 50 > 25. Not > hard. drop head. head=[u1,u2,u3] drop. 20t ≤ 25, stop.
    // Result: 2 messages (u4, u5 — both implicit-pinned).
    const mem = new ConversationMemory({
      softTokenBudget: 25,
      hardTokenBudget: 1000,
      preserveRecentCount: 2,
    });
    for (let i = 0; i < 5; i++) {
      mem.add(asciiMessage('user', 40));
    }
    expect(mem.get().length).toBe(2);
  });
});

// ─── Pinning ──────────────────────────────────────────────────────────────

describe('ConversationMemory pinning', () => {
  test('pinMessage защищает сообщение от drop', () => {
    // soft 20, hard 100, preserveRecentCount=2.
    // Add 5 × 10t. Last 2 implicit. pin idx 0. head = [u1] pinned = [].
    // dropOldestDroppable: u1 pinned, u2 droppable, drop. 40. drop u3. 30.
    // drop u4. 20 = 20, stop. 4 messages left: u1, u4, u5 (last 2 implicit).
    // Pinned: u1 + u4,u5 implicit = 3.
    const mem = new ConversationMemory({
      softTokenBudget: 20,
      hardTokenBudget: 100,
      preserveRecentCount: 2,
    });
    mem.add(asciiMessage('user', 40)); // idx 0
    mem.pinMessage(0);
    for (let i = 1; i < 5; i++) mem.add(asciiMessage('user', 40));
    const visible = mem.get();
    // u1 (pinned) должен быть в видимом — все сообщения одинаковые
    // по content ('x'.repeat(40)), но pinned индекс 0 должен сохраниться.
    const pinned = mem.getPinnedIndices();
    expect(pinned).toContain(0);
    // Pinned count ≥ 3 (u1 manual + 2 implicit)
    expect(pinned.length).toBeGreaterThanOrEqual(3);
    // Manual pin отдельно
    expect(mem.getManualPinnedIndices()).toContain(0);
  });

  test('unpinMessage снимает защиту', () => {
    // preserveRecentCount=0, чтобы manual-pin был единственным источником pin.
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    mem.add(asciiMessage('user', 4));
    mem.pinMessage(0);
    expect(mem.getPinnedIndices()).toContain(0);
    mem.unpinMessage(0);
    expect(mem.getPinnedIndices()).not.toContain(0);
    expect(mem.getManualPinnedIndices()).not.toContain(0);
  });

  test('getPinnedIndices возвращает массив индексов', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'system', content: 'sys' }); // idx 0 (system pinned)
    mem.add(asciiMessage('user', 4)); // idx 1
    mem.pinMessage(1);
    const pinned = mem.getPinnedIndices();
    expect(pinned).toContain(0);
    expect(pinned).toContain(1);
  });
});

// ─── Hard budget / overflow error ─────────────────────────────────────────

describe('ConversationMemory hard budget / overflow', () => {
  test('hard budget exceeded + droppable: дропает без throw', () => {
    // soft 5, hard 30, preserveRecentCount=0.
    // Add 5 × 10t = 50t. First add: 10t > 5. head=[u1] (just added, droppable).
    // 10 not > 30. drop head. 0. < 5, stop. Result: 1 message.
    const mem = new ConversationMemory({
      softTokenBudget: 5,
      hardTokenBudget: 30,
      preserveRecentCount: 0,
    });
    for (let i = 0; i < 5; i++) mem.add(asciiMessage('user', 40));
    expect(() => mem.get()).not.toThrow();
    expect(mem.getStats().droppedMessages).toBeGreaterThan(0);
  });

  test('hard budget exceeded + no droppable + no summarizer: throws MemoryOverflowError', () => {
    // soft 0, hard 0 (sanitize → equal). add sys (3 chars = 1t). 1t > 0 hard.
    // head=[sys] pinned=[]. Throw.
    const mem = new ConversationMemory({
      softTokenBudget: 0,
      hardTokenBudget: 0,
      preserveRecentCount: 0,
    });
    expect(() => mem.add({ role: 'system', content: 'sys' })).toThrow(
      MemoryOverflowError,
    );
  });

  test('MemoryOverflowError имеет code, tokens, budget, pinnedCount', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 0,
      hardTokenBudget: 0,
      preserveRecentCount: 0,
    });
    try {
      mem.add({ role: 'system', content: 'sys' });
      expect.unreachable('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(MemoryOverflowError);
      const err = e as MemoryOverflowError;
      expect(err.code).toBe('OVERFLOW');
      expect(typeof err.tokens).toBe('number');
      expect(typeof err.budget).toBe('number');
      expect(typeof err.pinnedCount).toBe('number');
      expect(err.budget).toBe(0);
      expect(err.pinnedCount).toBe(1);
    }
  });
});

// ─── Summarization (через compact()) ──────────────────────────────────────

describe('ConversationMemory summarizer (via compact)', () => {
  test('compact: droppable head ≥ 2 → replaced with 1 summary message', async () => {
    // summarizer настроен → add() не дропает. soft 1000 — всё влезает.
    // compact: head = [u1,u2,u3] (no system, all droppable). length 3 ≥ 2.
    // summarize. Result: 1 message (summary).
    const summarizer = async (msgs: LLMMessage[]) =>
      `compacted ${msgs.length} messages`;
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
      summarizer,
    });
    mem.add({ role: 'user', content: 'q1' });
    mem.add({ role: 'user', content: 'q2' });
    mem.add({ role: 'user', content: 'q3' });
    const before = mem.get().length;
    const changed = await mem.compact();
    expect(changed).toBe(3);
    const after = mem.get();
    expect(after.length).toBe(1);
    const summary = after[0];
    expect(summary.role).toBe('system');
    expect(summary.content.toString()).toContain('[Earlier context:');
    expect(summary.content.toString()).toContain('compacted 3 messages');
    expect(mem.getStats().summarizedMessages).toBe(1);
    expect(mem.getStats().droppedMessages).toBe(3);
  });

  test('compact preserves system + recent + pinned', async () => {
    // soft 1000, preserveRecentCount=2, summarizer.
    // Add sys + 5 users. add() не дропает.
    // compact: applyImplicitPinning → last 2 (u4, u5) pinned.
    // head from start: [sys] pinned = []. tokens 51 ≤ soft 1000.
    // Return 0. compact ничего не делает.
    // Hmm — этот сценарий не показывает summary. Нужно форсить.
    // Используем setConfig для понижения soft.
    const summarizer = async (msgs: LLMMessage[]) => `sum(${msgs.length})`;
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 2,
      summarizer,
    });
    mem.add({ role: 'system', content: 'ORIGINAL_SYSTEM' });
    mem.pinMessage(0);
    for (let i = 0; i < 5; i++) {
      mem.add({ role: i % 2 === 0 ? 'user' : 'assistant', content: 'x'.repeat(40) });
    }
    // Понижаем soft → trimSync (auto-drop без summarizer? Нет, summarizer есть, auto-trim OFF).
    // setConfig не вызывает trimSync если summarizer есть. Нужно явно compact.
    // compact: applyImplicitPinning (last 2 pinned). head = [sys] pinned = [].
    // tokens 51 ≤ soft 1000. Return 0.
    // Hmm. Force-fallback только при tokens > soft. Поэтому понизим soft.
    mem.setConfig({ softTokenBudget: 5 });
    // setConfig с summarizer set — не вызывает trimSync. Нужно compact.
    const changed = await mem.compact();
    expect(changed).toBeGreaterThan(0);
    const visible = mem.get();
    // System должен остаться
    expect(visible.some((m) => m.content.toString() === 'ORIGINAL_SYSTEM')).toBe(
      true,
    );
    // Summary присутствует
    const hasSummary = visible.some((m) =>
      m.content.toString().includes('[Earlier context'),
    );
    expect(hasSummary).toBe(true);
  });

  test('compact без summarizer: no-op', async () => {
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    mem.add({ role: 'user', content: 'a' });
    mem.add({ role: 'user', content: 'b' });
    mem.add({ role: 'user', content: 'c' });
    const before = mem.get().length;
    const changed = await mem.compact();
    expect(changed).toBe(0);
    expect(mem.get().length).toBe(before);
  });

  test('summarizer вернул пустую строку → drop без replacement', async () => {
    const summarizer = async () => '   ';
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
      summarizer,
    });
    mem.add({ role: 'user', content: 'a' });
    mem.add({ role: 'user', content: 'b' });
    mem.add({ role: 'user', content: 'c' });
    const before = mem.get().length;
    const changed = await mem.compact();
    expect(changed).toBe(3);
    const after = mem.get();
    expect(after.length).toBe(0);
    const hasSummary = after.some((m) =>
      m.content.toString().includes('[Earlier context:'),
    );
    expect(hasSummary).toBe(false);
  });

  test('summarizer throws → caught, fallback drop без summary', async () => {
    const summarizer = async () => {
      throw new Error('LLM offline');
    };
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
      summarizer,
    });
    mem.add({ role: 'user', content: 'a' });
    mem.add({ role: 'user', content: 'b' });
    mem.add({ role: 'user', content: 'c' });
    const before = mem.get().length;
    const changed = await mem.compact();
    expect(changed).toBe(3);
    const after = mem.get();
    expect(after.length).toBe(0);
    // No throw
  });

  test('compact с head.length = 1: no-op (1 сообщение не стоит свёртки)', async () => {
    const summarizer = async () => 'sum';
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
      summarizer,
    });
    mem.add({ role: 'user', content: 'only' });
    const before = mem.get().length;
    const changed = await mem.compact();
    expect(changed).toBe(0);
    expect(mem.get().length).toBe(before);
  });
});

// ─── Edge cases ───────────────────────────────────────────────────────────

describe('ConversationMemory edge cases', () => {
  test('soft budget = 0 без summarizer: drop кроме system', () => {
    // soft 0, hard 1000. add sys (3 chars = 1t). 1t > 0. head=[sys] pinned=[].
    // 1 not > 1000. dropOldestDroppable: sys pinned, no more. break. Result: sys.
    const mem = new ConversationMemory({
      softTokenBudget: 0,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    mem.add({ role: 'system', content: 'sys' });
    mem.add(asciiMessage('user', 4));
    mem.add(asciiMessage('user', 4));
    const visible = mem.get();
    expect(visible.length).toBe(1);
    expect(visible[0].role).toBe('system');
  });

  test('negative budget clamped to 0', () => {
    const mem = new ConversationMemory({
      softTokenBudget: -100,
      hardTokenBudget: -50,
      preserveRecentCount: 0,
    });
    expect(mem.getConfig().softTokenBudget).toBe(0);
    expect(mem.getConfig().hardTokenBudget).toBe(0);
  });

  test('setConfig: runtime change trims при необходимости (no summarizer)', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 1000,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    for (let i = 0; i < 5; i++) mem.add(asciiMessage('user', 40));
    expect(mem.get().length).toBe(5);
    mem.setConfig({ softTokenBudget: 20, hardTokenBudget: 1000 });
    // 50t > 20 → дропаем
    expect(mem.get().length).toBeLessThan(5);
  });

  test('1000 messages batch: addMany + auto-trim (no summarizer)', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 100,
      hardTokenBudget: 200,
      preserveRecentCount: 2,
    });
    const batch: LLMMessage[] = [];
    for (let i = 0; i < 1000; i++) {
      batch.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `m${i}`,
      });
    }
    mem.addMany(batch);
    // Должно быть под budget, не over hard.
    const visible = mem.get();
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.length).toBeLessThan(1000);
  });

  test('Cyrillic: 1000-char считается по UTF-16 code units (charsPerToken=4)', () => {
    const m = cyrillicMessage('user', 1000);
    // 1000 chars / 4 = 250 tokens
    expect(estimateMessageTokens(m, 4, DEFAULT_IMAGE_TOKENS)).toBe(250);
  });

  test('Cyrillic в диалоге: корректный budget enforcement', () => {
    // soft 100, hard 100, preserveRecentCount=1.
    // add u1: 100t, = soft, ok. 1 msg. implicit pin u1 (last 1).
    // add u2: 200t > hard 100. dropOldestDroppable: u1 not pinned (not implicit
    // because last 1 = u2, not u1). drop u1. 100t ≤ hard, stop. 1 msg (u2).
    const mem = new ConversationMemory({
      softTokenBudget: 100,
      hardTokenBudget: 100,
      preserveRecentCount: 1,
    });
    mem.add(cyrillicMessage('user', 400));
    mem.add(cyrillicMessage('user', 400));
    const visible = mem.get();
    expect(visible.length).toBe(1);
  });
});

// ─── Default config sanity ────────────────────────────────────────────────

describe('ConversationMemory default config', () => {
  test('DEFAULT_MEMORY_CONFIG имеет ожидаемые дефолты', () => {
    expect(DEFAULT_MEMORY_CONFIG.softTokenBudget).toBe(6000);
    expect(DEFAULT_MEMORY_CONFIG.hardTokenBudget).toBe(8000);
    expect(DEFAULT_MEMORY_CONFIG.preserveRecentCount).toBe(4);
    expect(DEFAULT_MEMORY_CONFIG.charsPerToken).toBe(4);
    expect(DEFAULT_MEMORY_CONFIG.imageTokens).toBe(765);
  });

  test('new ConversationMemory() использует defaults', () => {
    const mem = new ConversationMemory();
    const cfg = mem.getConfig();
    expect(cfg.softTokenBudget).toBe(6000);
    expect(cfg.hardTokenBudget).toBe(8000);
    expect(cfg.preserveRecentCount).toBe(4);
    expect(cfg.charsPerToken).toBe(4);
  });

  test('конструктор без аргументов: добавление работает', () => {
    const mem = new ConversationMemory();
    mem.add({ role: 'user', content: 'hi' });
    expect(mem.get().length).toBe(1);
  });
});

// ─── getStats ─────────────────────────────────────────────────────────────

describe('ConversationMemory.getStats', () => {
  test('после drop: droppedMessages > 0', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 5,
      hardTokenBudget: 1000,
      preserveRecentCount: 0,
    });
    for (let i = 0; i < 10; i++) mem.add(asciiMessage('user', 40));
    const s = mem.getStats();
    expect(s.droppedMessages).toBeGreaterThan(0);
    expect(s.totalMessages).toBeLessThan(10);
    expect(s.estimatedTokens).toBeLessThanOrEqual(1000);
  });

  test('budgetUtilization ∈ [0, 1+]', () => {
    const mem = new ConversationMemory({
      softTokenBudget: 10,
      hardTokenBudget: 50,
    });
    mem.add(asciiMessage('user', 200)); // 50 tokens = 1.0
    expect(mem.getStats().budgetUtilization).toBe(1);
  });
});
