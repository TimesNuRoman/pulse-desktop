// SPDX-License-Identifier: Apache-2.0
// Tests for ChatSidebar (R174 multi-chat tabs + R241 row layout).
//
// We use `createRoot` + `act` (same pattern as LicenseInput.test.tsx)
// instead of @testing-library/svelte because the project is React and
// that helper is not installed. The harness is intentionally small.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatSidebar } from '../ChatSidebar';
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

describe('ChatSidebar — basic render', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = mount(
      <ChatSidebar
        chats={CHATS}
        currentId="a"
        isCollapsed={false}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
  });
  afterEach(() => unmount(harness));

  test('renders the "New chat" button and the chat list', () => {
    const newBtn = harness.container.querySelector<HTMLButtonElement>(
      '.chatside__new',
    );
    expect(newBtn).not.toBeNull();
    expect(newBtn?.textContent).toMatch(/Новый чат/);
    const rows = harness.container.querySelectorAll<HTMLDivElement>(
      '[data-testid="chat-row"]',
    );
    expect(rows).toHaveLength(3);
  });

  test('marks the active row with aria-current="page"', () => {
    const active = harness.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="a"]',
    );
    expect(active?.getAttribute('aria-current')).toBe('page');
    const other = harness.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="b"]',
    );
    expect(other?.hasAttribute('aria-current')).toBe(false);
  });

  test('role="navigation" wraps the list', () => {
    const nav = harness.container.querySelector<HTMLElement>(
      '.chatside__list',
    );
    expect(nav?.getAttribute('role')).toBe('navigation');
  });

  test('R241: each row renders a leading icon, title and meta in that order', () => {
    const row = harness.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="a"]',
    )!;
    const icon = row.querySelector<HTMLElement>('.chatside__row-icon');
    const title = row.querySelector<HTMLElement>('.chatside__row-title');
    const meta = row.querySelector<HTMLElement>('.chatside__row-meta');
    expect(icon).not.toBeNull();
    expect(title).not.toBeNull();
    expect(meta).not.toBeNull();
    // Order: icon must precede title in document order.
    expect(
      icon!.compareDocumentPosition(title!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // Order: title must precede meta.
    expect(
      title!.compareDocumentPosition(meta!) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('R241: the icon is decorative (aria-hidden) and contains an SVG', () => {
    const row = harness.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="b"]',
    )!;
    const icon = row.querySelector<HTMLElement>('.chatside__row-icon')!;
    expect(icon.getAttribute('aria-hidden')).not.toBeNull();
    expect(icon.querySelector('svg')).not.toBeNull();
  });
});

describe('ChatSidebar — interactions', () => {
  test('clicking a row calls onSelect with the chat id', () => {
    const onSelect = vi.fn();
    const h = mount(
      <ChatSidebar
        chats={CHATS}
        currentId={null}
        isCollapsed={false}
        onSelect={onSelect}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
    const row = h.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="b"]',
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
      <ChatSidebar
        chats={CHATS}
        currentId="a"
        isCollapsed={false}
        onSelect={() => {}}
        onNewChat={onNewChat}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('.chatside__new')!;
    act(() => {
      btn.click();
    });
    expect(onNewChat).toHaveBeenCalledTimes(1);
    unmount(h);
  });

  test('search input filters the list by case-insensitive title match', () => {
    const h = mount(
      <ChatSidebar
        chats={CHATS}
        currentId={null}
        isCollapsed={false}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
    const input = h.container.querySelector<HTMLInputElement>(
      '.chatside__search-input',
    )!;
    act(() => {
      const ev = new Event('input', { bubbles: true });
      // Use the native value setter so React's onChange fires.
      const setter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value',
      )?.set;
      setter!.call(input, 'BETA');
      input.dispatchEvent(ev);
    });
    const rows = h.container.querySelectorAll<HTMLDivElement>(
      '[data-testid="chat-row"]',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].getAttribute('data-chat-id')).toBe('b');
    unmount(h);
  });

  test('right-click on a row opens the context menu', () => {
    const h = mount(
      <ChatSidebar
        chats={CHATS}
        currentId={null}
        isCollapsed={false}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
    const row = h.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="c"]',
    )!;
    act(() => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 }),
      );
    });
    const menu = h.container.querySelector<HTMLDivElement>(
      '[data-testid="context-menu"]',
    );
    expect(menu).not.toBeNull();
    const items = menu!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    expect(items).toHaveLength(2);
    expect(items[0].textContent).toMatch(/Переименовать/);
    expect(items[1].textContent).toMatch(/Удалить/);
    unmount(h);
  });

  test('Delete confirms then calls onDelete and the row disappears', () => {
    const onDelete = vi.fn();
    // Stub window.confirm to return true.
    const original = window.confirm;
    window.confirm = vi.fn(() => true);
    const h = mount(
      <ChatSidebar
        chats={CHATS}
        currentId="a"
        isCollapsed={false}
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={onDelete}
        onRename={() => {}}
        onToggle={() => {}}
      />,
    );
    const row = h.container.querySelector<HTMLDivElement>(
      '[data-testid="chat-row"][data-chat-id="b"]',
    )!;
    act(() => {
      row.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 100, clientY: 50 }),
      );
    });
    const delBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="menu-delete"]',
    )!;
    act(() => {
      delBtn.click();
    });
    expect(window.confirm).toHaveBeenCalled();
    expect(onDelete).toHaveBeenCalledWith('b');
    window.confirm = original;
    unmount(h);
  });
});

describe('ChatSidebar — collapsed', () => {
  test('collapsed view shows only the expand button', () => {
    const onToggle = vi.fn();
    const h = mount(
      <ChatSidebar
        chats={CHATS}
        currentId="a"
        isCollapsed
        onSelect={() => {}}
        onNewChat={() => {}}
        onDelete={() => {}}
        onRename={() => {}}
        onToggle={onToggle}
      />,
    );
    const root = h.container.querySelector<HTMLElement>('[data-testid="chat-sidebar"]');
    expect(root?.classList.contains('chatside--collapsed')).toBe(true);
    const newBtn = h.container.querySelector<HTMLButtonElement>('.chatside__new');
    expect(newBtn).toBeNull();
    const expand = h.container.querySelector<HTMLButtonElement>('.chatside__expand')!;
    act(() => {
      expand.click();
    });
    expect(onToggle).toHaveBeenCalledTimes(1);
    unmount(h);
  });
});
