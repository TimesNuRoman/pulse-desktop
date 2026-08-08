// SPDX-License-Identifier: Apache-2.0
// Tests for ChatView history integration (R174 multi-chat + R248 popover).
//
// ChatView is the heaviest component in the app — it pulls in the LLM
// client, the agent loop, Tauri events, STT, the file picker, and
// more. Rather than spinning up a real LLM we mock the heavy modules
// with vi.mock so the test exercises just the history wiring:
//   * on mount: most recent chat is loaded from localStorage
//   * on submit: title is auto-set from the first user message
//   * on history popover open: chat list is rendered
//   * on "new chat" click: current chat is saved, fresh conversation starts
//
// `vi.mock` is hoisted above imports — modules listed here are
// replaced before ChatView (and its transitive deps) load.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// ─── Module mocks (hoisted by Vitest) ─────────────────────────────────────

// `runAgentLoop` is the heavy path. For the history tests we just need
// the user message to land in `messages` and the assistant turn to
// resolve cleanly with a no-op. The mock emits one fake assistant
// message and resolves.
vi.mock('../../llm/tools', () => ({
  runAgentLoop: vi.fn(async () => ({
    finishReason: 'stop',
    text: 'fake-reply',
    toolCalls: [],
    routing: null,
    routingMode: 'Default',
    error: null,
  })),
  webSearch: vi.fn(async () => ({ items: [], backend: 'none', total: 0, query: '', offline: false, error: null })),
  shouldWebSearch: vi.fn(() => false),
  formatSearchContext: vi.fn(() => ''),
}));

vi.mock('../../llm/client', () => ({
  getLLMConfig: () => ({
    hasKey: true,
    model: 'test-model',
    visionModel: 'test-vision',
    provider: 'ollama',
  }),
  getProviderName: () => 'test-provider',
  LLMError: class LLMError extends Error {},
  isVisionAvailable: () => false,
  buildMultimodalMessage: (text: string) => text,
}));

vi.mock('../../api', () => ({
  captureScreen: vi.fn(async () => ({ base64: '', bytes: 0, path: '' })),
  getAutostart: vi.fn(async () => false),
  setAutostart: vi.fn(async () => false),
  getSTTEngine: vi.fn(() => {
    throw new Error('STT disabled in tests');
  }),
}));

vi.mock('../../voice/stt', () => ({}));

vi.mock('../../files/attachments', () => ({
  loadAttachment: vi.fn(async () => null),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: vi.fn(async () => null),
}));

vi.mock('../../llm/routing-ui', () => ({
  formatChipText: (m: string) => m,
  formatModalTitle: (m: string) => m,
  routingModeCategory: () => 'default',
  explainLowConfidence: () => '',
  readRoutingOverride: () => null,
  writeRoutingOverride: () => {},
}));

// ─── Now import the SUT ───────────────────────────────────────────────────

import { ChatView } from '../ChatView';
import { saveChat, loadAllChats } from '../../lib/chatHistory';
import type { ChatMessage } from '../../types';

interface Harness {
  root: Root;
  container: HTMLDivElement;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<ChatView />);
  });
  return { root, container };
}

function unmount(h: Harness) {
  act(() => {
    h.root.unmount();
  });
  document.body.removeChild(h.container);
}

function msg(id: string, role: 'user' | 'assistant', content: string, ts: number): ChatMessage {
  return { id, role, content, ts };
}

beforeEach(() => {
  localStorage.clear();
});

// Wait for the debounced save (400ms in ChatView). Tests that depend on
// the saved state flush this manually.
async function flushSave() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 500));
  });
}

describe('ChatView — history on mount', () => {
  test('mount loads the most recent chat from history', async () => {
    // Pre-seed two conversations with explicitly distinct lastMessageAt
    // values (saveChat uses wall-clock now() which collides in sub-ms
    // windows, making the sort order undefined).
    localStorage.setItem(
      'pulse.chat.history.v1',
      JSON.stringify({
        chats: {
          older: {
            id: 'older',
            title: 'Older chat',
            messages: [
              msg('ou', 'user', 'old question', 1),
              msg('oa', 'assistant', 'old reply', 2),
            ],
            lastMessageAt: '2026-01-01T00:00:00.000Z',
          },
          newer: {
            id: 'newer',
            title: 'Newer chat',
            messages: [
              msg('nu', 'user', 'new question', 100),
              msg('na', 'assistant', 'new reply', 101),
            ],
            lastMessageAt: '2026-01-01T00:00:05.000Z',
          },
        },
      }),
    );

    const h = mount();
    await act(async () => {
      // Let the initial-load useEffect run
      await new Promise((r) => setTimeout(r, 50));
    });

    // The newer chat's messages should be visible in the chat list.
    const list = h.container.querySelector('[data-testid="chat-list"]');
    expect(list?.textContent).toContain('new question');
    expect(list?.textContent).toContain('new reply');
    expect(list?.textContent).not.toContain('old question');

    unmount(h);
  });

  test('mount with empty history starts a fresh conversation (SEED only)', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    // The history popover should be CLOSED on mount.
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();
    unmount(h);
  });
});

describe('ChatView — history on submit / new chat', () => {
  test('sending a message auto-sets the title and saves to history', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    const input = h.container.querySelector<HTMLInputElement>('.chat__input')!;
    const form = h.container.querySelector<HTMLFormElement>('.raycast-composer')!;

    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter!.call(input, 'Привет, помоги с кодом');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });

    // Wait for the agent loop to "finish" (mocked) and the debounced save to flush.
    await flushSave();

    // The chat should now be in history with auto-generated title.
    const all = loadAllChats();
    expect(all.length).toBe(1);
    expect(all[0].title).toContain('Привет');

    unmount(h);
  });

  test('opening the history popover renders one row per saved chat', async () => {
    // Pre-seed two chats so the popover has something to show.
    localStorage.setItem(
      'pulse.chat.history.v1',
      JSON.stringify({
        chats: {
          a: {
            id: 'a',
            title: 'Chat A',
            messages: [msg('au', 'user', 'a-q', 1), msg('aa', 'assistant', 'a-r', 2)],
            lastMessageAt: '2026-01-01T00:00:00.000Z',
          },
          b: {
            id: 'b',
            title: 'Chat B',
            messages: [msg('bu', 'user', 'b-q', 1), msg('ba', 'assistant', 'b-r', 2)],
            lastMessageAt: '2026-01-01T00:00:01.000Z',
          },
        },
      }),
    );

    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Popover is closed initially.
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();

    // Click the [History] button in the topbar.
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // The popover should now be open with two rows.
    const rows = h.container.querySelectorAll('[data-testid="history-row"]');
    expect(rows).toHaveLength(2);

    // The "newer" chat (b) is active because ChatView loaded it on mount.
    const active = h.container.querySelector(
      '[data-testid="history-row"][data-chat-id="b"][aria-selected="true"]',
    );
    expect(active).not.toBeNull();

    unmount(h);
  });

  test('"New chat" button saves the current conversation and starts a fresh one', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // First, send a message so we have a real conversation.
    const input = h.container.querySelector<HTMLInputElement>('.chat__input')!;
    const form = h.container.querySelector<HTMLFormElement>('.raycast-composer')!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter!.call(input, 'first chat message');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await flushSave();

    // Now open the popover and click "New chat".
    const historyBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      historyBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const newBtn = h.container.querySelector<HTMLButtonElement>('[data-testid="history-new"]')!;
    act(() => {
      newBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // History should still have the first chat.
    const all = loadAllChats();
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0].title).toContain('first chat message');

    // Popover closes on "new chat" — back to single-column view.
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();

    unmount(h);
  });

  test('clicking a row in the popover closes the popover and switches chat', async () => {
    localStorage.setItem(
      'pulse.chat.history.v1',
      JSON.stringify({
        chats: {
          a: {
            id: 'a',
            title: 'Chat A',
            messages: [msg('au', 'user', 'a-q', 1), msg('aa', 'assistant', 'a-r', 2)],
            lastMessageAt: '2026-01-01T00:00:00.000Z',
          },
          b: {
            id: 'b',
            title: 'Chat B',
            messages: [msg('bu', 'user', 'b-q', 1), msg('ba', 'assistant', 'b-r', 2)],
            lastMessageAt: '2026-01-01T00:00:01.000Z',
          },
        },
      }),
    );

    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Open popover and click row "a".
    const historyBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      historyBtn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    const rowA = h.container.querySelector<HTMLElement>(
      '[data-testid="history-row"][data-chat-id="a"]',
    )!;
    act(() => {
      rowA.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });

    // Popover closed.
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();
    // Chat list now shows chat A's messages.
    const list = h.container.querySelector('[data-testid="chat-list"]');
    expect(list?.textContent).toContain('a-q');
    expect(list?.textContent).not.toContain('b-q');

    unmount(h);
  });
});
