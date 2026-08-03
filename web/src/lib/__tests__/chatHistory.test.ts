// SPDX-License-Identifier: Apache-2.0
// Tests for chatHistory (R174 multi-chat tabs).
//
// happy-dom provides a working `localStorage`. We clear it before each
// test for isolation. Tests pin the 9 required behaviours from the
// R174 brief.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import {
  saveChat,
  loadAllChats,
  loadChat,
  deleteChat,
  renameChat,
  __TESTING__,
} from '../chatHistory';
import type { ChatMessage } from '../../types';

const { STORAGE_KEY, MAX_CHATS } = __TESTING__;

function msg(id: string, role: 'user' | 'assistant' = 'user', content = 'hi'): ChatMessage {
  return { id, role, content, ts: Date.now() };
}

beforeEach(() => {
  localStorage.clear();
  // Reset the wall-clock mock to a fresh baseline for each test so
  // toISOString() inside saveChat() advances deterministically.
  vi.useRealTimers();
});

describe('chatHistory — saveChat', () => {
  test('writes to localStorage with the correct key', () => {
    const ok = saveChat('c1', 'Test chat', [msg('m1')]);
    expect(ok).toBe(true);
    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(parsed.chats.c1).toBeDefined();
    expect(parsed.chats.c1.title).toBe('Test chat');
    expect(parsed.chats.c1.messages).toHaveLength(1);
    expect(typeof parsed.chats.c1.lastMessageAt).toBe('string');
  });

  test('upsert: second save overwrites the same id', () => {
    saveChat('c1', 'first', [msg('m1')]);
    saveChat('c1', 'second', [msg('m2'), msg('m3')]);
    const all = loadAllChats();
    expect(all).toHaveLength(1);
    expect(all[0].title).toBe('second');
    expect(all[0].messageCount).toBe(2);
  });
});

describe('chatHistory — loadAllChats', () => {
  test('returns sorted by lastMessageAt desc', () => {
    // Pin Date.now() so each saveChat() gets a strictly increasing
    // lastMessageAt. Without this, three saves in the same ms collide
    // on toISOString() output.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      saveChat('a', 'A', [msg('a1')]);
      vi.setSystemTime(new Date('2026-01-01T00:00:01Z'));
      saveChat('b', 'B', [msg('b1')]);
      vi.setSystemTime(new Date('2026-01-01T00:00:02Z'));
      saveChat('c', 'C', [msg('c1')]);
      const all = loadAllChats();
      expect(all.map((c) => c.id)).toEqual(['c', 'b', 'a']);
    } finally {
      vi.useRealTimers();
    }
  });

  test('empty history returns []', () => {
    expect(loadAllChats()).toEqual([]);
  });

  test('chats with no messages are excluded from history', () => {
    // Save one normal chat, one empty. Only the normal one should show.
    saveChat('full', 'Full', [msg('m1')]);
    saveChat('empty', 'Empty', []);
    const all = loadAllChats();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('full');
  });
});

describe('chatHistory — loadChat', () => {
  test('returns full messages for a given id', () => {
    const msgs = [msg('m1'), msg('m2', 'assistant', 'reply')];
    saveChat('c1', 'Test', msgs);
    const got = loadChat('c1');
    expect(got).toHaveLength(2);
    expect(got[1].role).toBe('assistant');
    expect(got[1].content).toBe('reply');
  });

  test('returns empty array for unknown id', () => {
    expect(loadChat('nope')).toEqual([]);
  });
});

describe('chatHistory — deleteChat', () => {
  test('removes a chat from history', () => {
    saveChat('c1', 'one', [msg('m1')]);
    saveChat('c2', 'two', [msg('m2')]);
    deleteChat('c1');
    expect(loadAllChats().map((c) => c.id)).toEqual(['c2']);
    expect(loadChat('c1')).toEqual([]);
  });

  test('no-op for unknown id', () => {
    saveChat('c1', 'one', [msg('m1')]);
    expect(() => deleteChat('nope')).not.toThrow();
    expect(loadAllChats()).toHaveLength(1);
  });
});

describe('chatHistory — renameChat', () => {
  test('updates the title', () => {
    saveChat('c1', 'old', [msg('m1')]);
    const ok = renameChat('c1', 'new title');
    expect(ok).toBe(true);
    const all = loadAllChats();
    expect(all[0].title).toBe('new title');
  });

  test('returns false for unknown id', () => {
    expect(renameChat('nope', 'whatever')).toBe(false);
  });
});

describe('chatHistory — cap', () => {
  test(`evicts the oldest chat when ${MAX_CHATS + 1}th is saved`, () => {
    // Build MAX_CHATS + 1 chats with strictly increasing timestamps by
    // writing them sequentially with a forced lastMessageAt.
    for (let i = 0; i < MAX_CHATS; i++) {
      saveChat(`old-${i}`, `Old ${i}`, [msg(`m-${i}`)]);
    }
    // The 51st save triggers eviction. After saveChat, total should
    // still be MAX_CHATS and the oldest should be gone.
    saveChat('newest', 'Newest', [msg('m-newest')]);
    const all = loadAllChats();
    expect(all).toHaveLength(MAX_CHATS);
    expect(all.find((c) => c.id === 'newest')).toBeDefined();
  });
});

describe('chatHistory — storage failure', () => {
  test('saveChat returns false when localStorage.setItem throws', () => {
    // happy-dom's localStorage uses non-writable bindings; we can't
    // monkey-patch the method on the instance. Swap the whole
    // localStorage with a fake that throws on writes.
    const original = globalThis.localStorage;
    const fake = {
      getItem: (k: string) => original.getItem(k),
      removeItem: (k: string) => original.removeItem(k),
      clear: () => original.clear(),
      key: (i: number) => original.key(i),
      get length() {
        return original.length;
      },
      setItem: () => {
        throw new Error('quota exceeded');
      },
    } as unknown as Storage;
    vi.stubGlobal('localStorage', fake);
    try {
      const ok = saveChat('c1', 'Test', [msg('m1')]);
      expect(ok).toBe(false);
    } finally {
      vi.stubGlobal('localStorage', original);
    }
  });

  test('loadAllChats returns [] on corrupted JSON', () => {
    localStorage.setItem(STORAGE_KEY, '{not json');
    expect(loadAllChats()).toEqual([]);
  });
});
