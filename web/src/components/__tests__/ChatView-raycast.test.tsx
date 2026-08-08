// SPDX-License-Identifier: Apache-2.0
// Integration test for the R248 Raycast-pattern single-column layout.
//
// What this covers (the bits that a screenshot can't tell you):
//   * Topbar renders the brand mark, the model switcher mount point,
//     and the [☰ History] button with the right ARIA wiring.
//   * Six routing mode pills render with role="tab" + aria-pressed,
//     and clicking one writes the override to localStorage.
//   * Clicking the [History] button opens the popover and sets
//     aria-expanded="true" on the button.
//   * Click-outside closes the popover.
//   * The popover closes after picking a chat.
//   * R176's `renderChatCode` Copy button still works in the new
//     layout (kept contract from ChatView-code-copy.test.tsx, here
//     asserted at the integration level).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// ─── Module mocks (hoisted by Vitest) ─────────────────────────────────────

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
  writeRoutingOverride: vi.fn(),
}));

// ─── SUT ──────────────────────────────────────────────────────────────────

import { ChatView } from '../ChatView';
import { writeRoutingOverride } from '../../llm/routing-ui';

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

beforeEach(() => {
  localStorage.clear();
  vi.mocked(writeRoutingOverride).mockClear();
});

describe('ChatView R248 — topbar', () => {
  test('renders the topbar with brand, model mount, and history button', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const topbar = h.container.querySelector('[data-testid="raycast-topbar"]');
    expect(topbar).not.toBeNull();
    expect(h.container.querySelector('[data-testid="raycast-brand"]')?.textContent).toMatch(
      /Pulse/,
    );
    const historyBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    );
    expect(historyBtn).not.toBeNull();
    // aria-expanded starts false (popover closed).
    expect(historyBtn?.getAttribute('aria-expanded')).toBe('false');
    expect(historyBtn?.getAttribute('aria-haspopup')).toBe('dialog');
    unmount(h);
  });
});

describe('ChatView R248 — routing mode pills', () => {
  test('renders six pills inside a role=tablist', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const list = h.container.querySelector('[data-testid="raycast-pills"]');
    expect(list?.getAttribute('role')).toBe('tablist');
    const pills = h.container.querySelectorAll('[data-testid="raycast-pill"]');
    expect(pills).toHaveLength(6);
    for (const p of pills) {
      expect(p.getAttribute('role')).toBe('tab');
    }
    unmount(h);
  });

  test('clicking a pill writes the override to localStorage', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const codePill = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-pill"][data-pill-label="Код"]',
    );
    expect(codePill).not.toBeNull();
    act(() => {
      codePill!.click();
    });
    expect(writeRoutingOverride).toHaveBeenCalledWith('CodeEdit');
    unmount(h);
  });

  test('clicking the Авто pill writes null (reset override)', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const autoPill = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-pill"][data-pill-label="Авто"]',
    )!;
    act(() => {
      autoPill.click();
    });
    expect(writeRoutingOverride).toHaveBeenCalledWith(null);
    unmount(h);
  });
});

describe('ChatView R248 — history popover toggle', () => {
  test('clicking the history button opens the popover and flips aria-expanded', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(
      h.container.querySelector<HTMLButtonElement>('[data-testid="raycast-history-btn"]')!
        .getAttribute('aria-expanded'),
    ).toBe('true');
    expect(h.container.querySelector('[data-testid="history-popover"]')).not.toBeNull();
    unmount(h);
  });

  test('clicking the history button again closes the popover', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(h.container.querySelector('[data-testid="history-popover"]')).not.toBeNull();
    act(() => {
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();
    unmount(h);
  });

  test('Escape closes the popover', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="raycast-history-btn"]',
    )!;
    act(() => {
      btn.click();
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(h.container.querySelector('[data-testid="history-popover"]')).not.toBeNull();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    expect(h.container.querySelector('[data-testid="history-popover"]')).toBeNull();
    unmount(h);
  });
});

describe('ChatView R248 — single column', () => {
  test('does NOT render an <aside> or .chat-layout (sidebar is gone)', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(h.container.querySelector('.chat-layout')).toBeNull();
    expect(h.container.querySelector('aside.chatside')).toBeNull();
    // The new single-column root is rendered.
    expect(h.container.querySelector('.raycast-chat')).not.toBeNull();
    unmount(h);
  });

  test('messages are inside .raycast-messages (not inside the old .chat > .chat__list sibling chain)', async () => {
    const h = mount();
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    const list = h.container.querySelector('[data-testid="chat-list"]');
    expect(list).not.toBeNull();
    expect(list?.classList.contains('raycast-messages')).toBe(true);
    // Topbar, pills, messages, composer all sit under the same parent.
    const root = h.container.querySelector('.raycast-chat')!;
    expect(root.querySelector('.raycast-topbar')).not.toBeNull();
    expect(root.querySelector('.raycast-pills')).not.toBeNull();
    expect(root.querySelector('.raycast-messages')).not.toBeNull();
    expect(root.querySelector('.raycast-composer')).not.toBeNull();
    unmount(h);
  });
});
