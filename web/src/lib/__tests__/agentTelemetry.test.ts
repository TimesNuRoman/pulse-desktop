// SPDX-License-Identifier: Apache-2.0
//
// R194 — vitest tests для `agentTelemetry.ts`.
//
// Покрывает:
//   * recordEvent инкрементирует totalEvents + ring buffer
//   * recordLatency min/max/avg по 3 sample'ам (100/200/300 → avg=200)
//   * recordError stores error info
//   * subscribe fires on every record
//   * reset() clears all
//   * ring buffer caps at N=100
//   * incrementCounter
//   * edge cases: invalid latency, null error

import { describe, test, expect, vi } from 'vitest';
import {
  AgentTelemetry,
  DEFAULT_RING_BUFFER_SIZE,
  type TelemetrySnapshot,
} from '../agentTelemetry';

describe('AgentTelemetry', () => {
  describe('recordEvent', () => {
    test('pushes event to ring buffer', () => {
      const t = new AgentTelemetry();
      t.recordEvent('foo');
      t.recordEvent('bar', { x: 1 });
      const snap = t.snapshot();
      expect(snap.recentEvents).toHaveLength(2);
      expect(snap.recentEvents[0]!.name).toBe('foo');
      expect(snap.recentEvents[1]!.name).toBe('bar');
      expect(snap.recentEvents[1]!.attrs).toEqual({ x: 1 });
    });

    test('increments totalEvents', () => {
      const t = new AgentTelemetry();
      t.recordEvent('a');
      t.recordEvent('b');
      t.recordEvent('c');
      expect(t.snapshot().totalEvents).toBe(3);
    });

    test('event has ts timestamp', () => {
      const t = new AgentTelemetry();
      const before = Date.now();
      t.recordEvent('x');
      const after = Date.now();
      const ts = t.snapshot().recentEvents[0]!.ts;
      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });
  });

  describe('recordLatency', () => {
    test('tracks min/max/avg over 3 samples (100/200/300 → avg=200)', () => {
      const t = new AgentTelemetry();
      t.recordLatency('llm', 100);
      t.recordLatency('llm', 200);
      t.recordLatency('llm', 300);
      const stat = t.snapshot().latencies['llm']!;
      expect(stat.count).toBe(3);
      expect(stat.min).toBe(100);
      expect(stat.max).toBe(300);
      expect(stat.sum).toBe(600);
      expect(stat.avg).toBe(200);
    });

    test('separate names tracked independently', () => {
      const t = new AgentTelemetry();
      t.recordLatency('llm', 100);
      t.recordLatency('tool', 50);
      const snap = t.snapshot();
      expect(snap.latencies['llm']!.count).toBe(1);
      expect(snap.latencies['tool']!.count).toBe(1);
      expect(snap.latencies['llm']!.avg).toBe(100);
      expect(snap.latencies['tool']!.avg).toBe(50);
    });

    test('ignores invalid values (NaN, negative, Infinity)', () => {
      const t = new AgentTelemetry();
      t.recordLatency('x', NaN);
      t.recordLatency('x', -5);
      t.recordLatency('x', Infinity);
      t.recordLatency('x', 100);
      const stat = t.snapshot().latencies['x']!;
      expect(stat.count).toBe(1);
      expect(stat.avg).toBe(100);
    });
  });

  describe('recordError', () => {
    test('stores error info with name and message', () => {
      const t = new AgentTelemetry();
      const e = new TypeError('Failed to fetch');
      t.recordError('llm', e);
      const errs = t.snapshot().errors;
      expect(errs).toHaveLength(1);
      expect(errs[0]!.name).toBe('TypeError');
      expect(errs[0]!.message).toBe('Failed to fetch');
    });

    test('handles non-Error values (string, object)', () => {
      const t = new AgentTelemetry();
      t.recordError('a', 'just a string');
      t.recordError('b', { code: 500 });
      const errs = t.snapshot().errors;
      expect(errs).toHaveLength(2);
      expect(errs[0]!.name).toBe('Error');
      expect(errs[0]!.message).toBe('just a string');
      expect(errs[1]!.message).toBe('[object Object]');
    });

    test('increments errors.{name} counter', () => {
      const t = new AgentTelemetry();
      t.recordError('llm', new Error('e1'));
      t.recordError('llm', new Error('e2'));
      t.recordError('tool', new Error('e3'));
      const counters = t.snapshot().counters;
      expect(counters['errors.llm']).toBe(2);
      expect(counters['errors.tool']).toBe(1);
    });
  });

  describe('incrementCounter', () => {
    test('default increment by 1', () => {
      const t = new AgentTelemetry();
      t.incrementCounter('foo');
      t.incrementCounter('foo');
      t.incrementCounter('foo');
      expect(t.snapshot().counters['foo']).toBe(3);
    });

    test('custom increment by N', () => {
      const t = new AgentTelemetry();
      t.incrementCounter('bar', 5);
      t.incrementCounter('bar', 10);
      expect(t.snapshot().counters['bar']).toBe(15);
    });

    test('negative decrement', () => {
      const t = new AgentTelemetry();
      t.incrementCounter('x', 10);
      t.incrementCounter('x', -3);
      expect(t.snapshot().counters['x']).toBe(7);
    });
  });

  describe('subscribe', () => {
    test('fires on every record', () => {
      const t = new AgentTelemetry();
      const listener = vi.fn();
      t.subscribe(listener);
      t.recordEvent('a');
      t.recordLatency('b', 100);
      t.recordError('c', new Error('e'));
      t.incrementCounter('d');
      expect(listener).toHaveBeenCalledTimes(4);
    });

    test('listener receives fresh snapshot', () => {
      const t = new AgentTelemetry();
      let lastSnap: TelemetrySnapshot | null = null;
      t.subscribe((s) => { lastSnap = s; });
      t.recordEvent('foo', { x: 1 });
      expect(lastSnap).not.toBeNull();
      expect(lastSnap!.recentEvents).toHaveLength(1);
      expect(lastSnap!.recentEvents[0]!.name).toBe('foo');
    });

    test('returns unsubscribe function', () => {
      const t = new AgentTelemetry();
      const listener = vi.fn();
      const unsub = t.subscribe(listener);
      t.recordEvent('a');
      expect(listener).toHaveBeenCalledTimes(1);
      unsub();
      t.recordEvent('b');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    test('multiple subscribers all fire', () => {
      const t = new AgentTelemetry();
      const l1 = vi.fn();
      const l2 = vi.fn();
      t.subscribe(l1);
      t.subscribe(l2);
      t.recordEvent('x');
      expect(l1).toHaveBeenCalledTimes(1);
      expect(l2).toHaveBeenCalledTimes(1);
    });

    test('subscriberCount reflects active listeners', () => {
      const t = new AgentTelemetry();
      expect(t.subscriberCount).toBe(0);
      const u1 = t.subscribe(vi.fn());
      expect(t.subscriberCount).toBe(1);
      const u2 = t.subscribe(vi.fn());
      expect(t.subscriberCount).toBe(2);
      u1();
      expect(t.subscriberCount).toBe(1);
      u2();
      expect(t.subscriberCount).toBe(0);
    });
  });

  describe('reset', () => {
    test('clears counters, latencies, errors, ring buffer', () => {
      const t = new AgentTelemetry();
      t.recordEvent('a');
      t.recordLatency('llm', 100);
      t.recordError('e', new Error('e'));
      t.incrementCounter('c');
      t.reset();
      const snap = t.snapshot();
      expect(snap.counters).toEqual({});
      expect(snap.latencies).toEqual({});
      expect(snap.errors).toEqual([]);
      expect(snap.recentEvents).toEqual([]);
      expect(snap.totalEvents).toBe(0);
    });

    test('notify fires on reset', () => {
      const t = new AgentTelemetry();
      const listener = vi.fn();
      t.subscribe(listener);
      t.recordEvent('a');
      listener.mockClear();
      t.reset();
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });

  describe('ring buffer', () => {
    test('caps at N=100', () => {
      const t = new AgentTelemetry();
      for (let i = 0; i < 150; i++) t.recordEvent(`e${i}`);
      const ring = t.snapshot().recentEvents;
      expect(ring).toHaveLength(DEFAULT_RING_BUFFER_SIZE);
      // FIFO: первые 50 должны быть отброшены, последний — e149.
      expect(ring[0]!.name).toBe('e50');
      expect(ring[DEFAULT_RING_BUFFER_SIZE - 1]!.name).toBe('e149');
    });

    test('totalEvents counts all (not just ring size)', () => {
      const t = new AgentTelemetry();
      for (let i = 0; i < 200; i++) t.recordEvent(`e${i}`);
      expect(t.snapshot().totalEvents).toBe(200);
    });

    test('custom ringSize', () => {
      const t = new AgentTelemetry(5);
      for (let i = 0; i < 10; i++) t.recordEvent(`e${i}`);
      const ring = t.snapshot().recentEvents;
      expect(ring).toHaveLength(5);
      expect(ring[0]!.name).toBe('e5');
      expect(ring[4]!.name).toBe('e9');
    });

    test('ringSize < 1 throws', () => {
      expect(() => new AgentTelemetry(0)).toThrow();
    });
  });

  describe('snapshot immutability', () => {
    test('mutating snapshot does not affect internal state', () => {
      const t = new AgentTelemetry();
      t.recordEvent('a', { x: 1 });
      const snap1 = t.snapshot();
      snap1.recentEvents[0]!.name = 'mutated';
      // Добавляем ещё одно событие.
      t.recordEvent('b');
      const snap2 = t.snapshot();
      // snap1.recentEvents не должно влиять на snap2.
      expect(snap2.recentEvents[0]!.name).toBe('a');
      expect(snap2.recentEvents).toHaveLength(2);
    });
  });
});
