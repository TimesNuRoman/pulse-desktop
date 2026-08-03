// SPDX-License-Identifier: Apache-2.0
//
// R194 — vitest tests для `agentBudget.ts`.
//
// Покрывает:
//   * recordToolCall до лимита OK
//   * N+1-й вызов кидает BudgetExceededError с code='TOOL_CALLS'
//   * recordTurn аналогично
//   * recordTokens — накопление + лимит
//   * snapshot возвращает текущие счётчики
//   * custom limits respected
//   * BudgetExceededError extends Error правильно
//   * get-аксессоры для UI

import { describe, test, expect } from 'vitest';
import {
  AgentBudget,
  BudgetExceededError,
  DEFAULT_BUDGET_LIMITS,
} from '../agentBudget';

describe('AgentBudget', () => {
  describe('recordToolCall', () => {
    test('allows up to maxToolCalls (default 8)', () => {
      const b = new AgentBudget();
      for (let i = 0; i < DEFAULT_BUDGET_LIMITS.maxToolCalls; i++) {
        expect(() => b.recordToolCall()).not.toThrow();
      }
      expect(b.toolCalls).toBe(DEFAULT_BUDGET_LIMITS.maxToolCalls);
    });

    test('throws on 9th call with code=TOOL_CALLS', () => {
      const b = new AgentBudget();
      for (let i = 0; i < DEFAULT_BUDGET_LIMITS.maxToolCalls; i++) {
        b.recordToolCall();
      }
      let caught: unknown;
      try {
        b.recordToolCall();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BudgetExceededError);
      expect((caught as BudgetExceededError).code).toBe('TOOL_CALLS');
      expect((caught as BudgetExceededError).limit).toBe(DEFAULT_BUDGET_LIMITS.maxToolCalls);
      expect((caught as BudgetExceededError).actual).toBe(DEFAULT_BUDGET_LIMITS.maxToolCalls + 1);
    });

    test('custom maxToolCalls=2', () => {
      const b = new AgentBudget({ maxToolCalls: 2 });
      b.recordToolCall();
      b.recordToolCall();
      expect(() => b.recordToolCall()).toThrow(BudgetExceededError);
    });
  });

  describe('recordTurn', () => {
    test('allows up to maxTurns (default 15)', () => {
      const b = new AgentBudget();
      for (let i = 0; i < DEFAULT_BUDGET_LIMITS.maxTurns; i++) {
        expect(() => b.recordTurn()).not.toThrow();
      }
      expect(b.turns).toBe(DEFAULT_BUDGET_LIMITS.maxTurns);
    });

    test('throws on 16th turn with code=TURNS', () => {
      const b = new AgentBudget();
      for (let i = 0; i < DEFAULT_BUDGET_LIMITS.maxTurns; i++) {
        b.recordTurn();
      }
      let caught: unknown;
      try {
        b.recordTurn();
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BudgetExceededError);
      expect((caught as BudgetExceededError).code).toBe('TURNS');
      expect((caught as BudgetExceededError).limit).toBe(DEFAULT_BUDGET_LIMITS.maxTurns);
    });
  });

  describe('recordTokens', () => {
    test('accumulates tokens without throwing when under limit', () => {
      const b = new AgentBudget();
      b.recordTokens(100);
      b.recordTokens(200);
      b.recordTokens(300);
      expect(b.tokens).toBe(600);
    });

    test('throws on exceeding token limit', () => {
      const b = new AgentBudget({ maxTokens: 1000 });
      b.recordTokens(500);
      b.recordTokens(500); // total = 1000, ещё OK
      let caught: unknown;
      try {
        b.recordTokens(1); // total = 1001
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(BudgetExceededError);
      expect((caught as BudgetExceededError).code).toBe('TOKENS');
      expect((caught as BudgetExceededError).limit).toBe(1000);
    });

    test('ignores non-finite or negative values', () => {
      const b = new AgentBudget();
      b.recordTokens(NaN);
      b.recordTokens(-10);
      b.recordTokens(Infinity);
      expect(b.tokens).toBe(0);
    });

    test('floors fractional tokens', () => {
      const b = new AgentBudget();
      b.recordTokens(10.7);
      b.recordTokens(5.3);
      expect(b.tokens).toBe(15);
    });
  });

  describe('snapshot', () => {
    test('returns current counts and exceeded=false', () => {
      const b = new AgentBudget();
      b.recordToolCall();
      b.recordTurn();
      b.recordTokens(100);
      const snap = b.snapshot();
      expect(snap).toEqual({
        toolCalls: 1,
        turns: 1,
        tokens: 100,
        exceeded: false,
      });
    });

    test('exceeded is always false in snapshot (throw is the signal)', () => {
      const b = new AgentBudget({ maxToolCalls: 1 });
      b.recordToolCall();
      // snapshot всё равно exceeded: false — exceeded живёт только в throw.
      expect(b.snapshot().exceeded).toBe(false);
    });
  });

  describe('custom limits', () => {
    test('all 3 limits custom', () => {
      const b = new AgentBudget({
        maxToolCalls: 3,
        maxTurns: 5,
        maxTokens: 100,
      });
      expect(b.limits).toEqual({ maxToolCalls: 3, maxTurns: 5, maxTokens: 100 });
    });
  });
});

describe('BudgetExceededError', () => {
  test('extends Error', () => {
    const e = new BudgetExceededError('TOOL_CALLS', 8, 9);
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(BudgetExceededError);
  });

  test('has name=BudgetExceededError', () => {
    const e = new BudgetExceededError('TOOL_CALLS', 8, 9);
    expect(e.name).toBe('BudgetExceededError');
  });

  test('has code, limit, actual properties', () => {
    const e = new BudgetExceededError('TOKENS', 32000, 32001);
    expect(e.code).toBe('TOKENS');
    expect(e.limit).toBe(32000);
    expect(e.actual).toBe(32001);
  });

  test('message includes code, actual, limit', () => {
    const e = new BudgetExceededError('TURNS', 15, 16);
    expect(e.message).toContain('TURNS');
    expect(e.message).toContain('15');
    expect(e.message).toContain('16');
  });
});
