// SPDX-License-Identifier: Apache-2.0
// Tests for HistoryPopover (R248 Raycast pattern).
//
// Same harness as ChatSidebar.test.tsx / KeyboardHint.test.tsx:
// `createRoot` + `act` against happy-dom. No @testing-library.
//
// Coverage targets the Raycast-specific contract:
//   * Empty state (no chats, no search hits)
//   * Row click → onSelect + onClose
//   * Keyboard nav: Down/Up/Enter/Escape
//   * Rename: inline input, Enter commits, Escape cancels
//   * Delete: confirm + onDelete (popover stays open so user can keep working)
//   * ARIA: role=dialog, role=listbox, role=option[aria-selected]

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { HistoryPopover } from '../HistoryPopover';
import type { ChatSummary } from '../../lib/chatHistory';

interface Harness {
  root: Root;
  container: HTMLDivElement;
}

function mount(element: React.ReactElement): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { root, container };
}

function unmount(h: Harness) {
  act(() => {
    h.root.unmount();
  });
  document.body.removeChild(h.container);
}

const CHATS: ChatSummary[] = [
  { id: 'a', title: 'Alpha chat', lastMessageAt: '2026-01-01T12:02:00Z', messageCount: 5 },
  { id: 'b', title: 'Beta chat', lastMessageAt: '2026-01-01T12:01:00Z', messageCount: 3 },
  { id: 'c', title: 'Gamma chat', lastMessageAt: '2026-01-01T12:00:00Z', messageCount: 1 },
];

describe('HistoryPopover — render', () => {
  test('root has role=dialog, aria-modal=true and aria-label', () => {
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId="a"
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const root = h.container.querySelector<HTMLElement>('[data-testid="history-popover"]')!;
    expect(root.getAttribute('role')).toBe('dialog');
    expect(root.getAttribute('aria-modal')).toBe('true');
    expect(root.getAttribute('aria-label')).toBe('История чатов');
    unmount(h);
  });

  test('renders one row per chat with active row marked aria-selected', () => {
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId="a"
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const rows = h.container.querySelectorAll('[data-testid="history-row"]');
    expect(rows).toHaveLength(3);
    const active = h.container.querySelector('[data-testid="history-row"][data-chat-id="a"]');
    expect(active?.getAttribute('aria-selected')).toBe('true');
    const other = h.container.querySelector('[data-testid="history-row"][data-chat-id="b"]');
    expect(other?.getAttribute('aria-selected')).toBe('false');
    unmount(h);
  });

  test('zero chats renders the EmptyState illustration', () => {
    const h = mount(
      <HistoryPopover
        chats={[]}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const empty = h.container.querySelector('[data-testid="history-empty"]');
    expect(empty).not.toBeNull();
    expect(empty?.textContent).toMatch(/Нет сохранённых чатов/);
    unmount(h);
  });
});

describe('HistoryPopover — interactions', () => {
  test('clicking a row calls onSelect with the chat id', () => {
    const onSelect = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={onSelect}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const row = h.container.querySelector<HTMLElement>(
      '[data-testid="history-row"][data-chat-id="b"]',
    )!;
    act(() => {
      row.click();
    });
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('b');
    unmount(h);
  });

  test('clicking "New chat" calls onNewChat', () => {
    const onNewChat = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId="a"
        onSelect={() => {}}
        onNewChat={onNewChat}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('[data-testid="history-new"]')!;
    act(() => {
      btn.click();
    });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    unmount(h);
  });

  test('search input filters the list by case-insensitive title match', () => {
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const input = h.container.querySelector<HTMLInputElement>(
      '[data-testid="history-search"]',
    )!;
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter!.call(input, 'BETA');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const rows = h.container.querySelectorAll('[data-testid="history-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-chat-id')).toBe('b');
    unmount(h);
  });

  test('Escape inside search input closes the popover', () => {
    const onClose = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={onClose}
      />,
    );
    const input = h.container.querySelector<HTMLInputElement>(
      '[data-testid="history-search"]',
    )!;
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount(h);
  });
});

describe('HistoryPopover — keyboard nav on the list', () => {
  test('ArrowDown moves focus, Enter picks the focused row', () => {
    const onSelect = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={onSelect}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const list = h.container.querySelector<HTMLUListElement>('[data-testid="history-list"]')!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    // First focus was idx 0 (Alpha), ArrowDown → idx 1 (Beta), Enter → 'b'
    expect(onSelect).toHaveBeenCalledWith('b');
    unmount(h);
  });

  test('ArrowUp at the top stays at idx 0', () => {
    const onSelect = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={onSelect}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const list = h.container.querySelector<HTMLUListElement>('[data-testid="history-list"]')!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    });
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onSelect).toHaveBeenCalledWith('a');
    unmount(h);
  });

  test('Escape on the list closes the popover', () => {
    const onClose = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onClose={onClose}
      />,
    );
    const list = h.container.querySelector<HTMLUListElement>('[data-testid="history-list"]')!;
    act(() => {
      list.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    unmount(h);
  });
});

describe('HistoryPopover — rename / delete', () => {
  test('Rename: click button opens inline input, Enter commits', () => {
    const onRename = vi.fn();
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={onRename}
        onClose={() => {}}
      />,
    );
    const renameBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="history-row"][data-chat-id="b"] [data-testid="history-row-rename"]',
    )!;
    act(() => {
      renameBtn.click();
    });
    const input = h.container.querySelector<HTMLInputElement>(
      '.history-popover__rename',
    )!;
    expect(input).not.toBeNull();
    expect(input.value).toBe('Beta chat');
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter!.call(input, 'Renamed');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(onRename).toHaveBeenCalledWith('b', 'Renamed');
    unmount(h);
  });

  test('Delete: confirm → onDelete (popover stays open)', () => {
    const onDelete = vi.fn();
    const original = window.confirm;
    window.confirm = vi.fn(() => true);
    const h = mount(
      <HistoryPopover
        chats={CHATS}
        currentId={null}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
        onClose={() => {}}
      />,
    );
    const delBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="history-row"][data-chat-id="c"] [data-testid="history-row-delete"]',
    )!;
    act(() => {
      delBtn.click();
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith('c');
    // Popover still mounted after delete (parent decides when to close).
    expect(h.container.querySelector('[data-testid="history-popover"]')).not.toBeNull();
    window.confirm = original;
    unmount(h);
  });
});
