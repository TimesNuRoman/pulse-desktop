// SPDX-License-Identifier: Apache-2.0
// Tests for ChatCodeBlock (R176 chat code copy button).
//
// Uses the same `createRoot` + `act` harness as ChatSidebar / LicenseInput
// tests. We mock ../lib/clipboard so we can assert what the component
// would copy without dealing with real Clipboard API state.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { renderChatCode } from '../ChatCodeBlock';

// Mock the clipboard helper so the component does not touch the real
// Clipboard API. We control the resolution per-test.
vi.mock('../../lib/clipboard', () => ({
  copyToClipboard: vi.fn().mockResolvedValue(true),
}));
import { copyToClipboard } from '../../lib/clipboard';

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

/**
 * Flush microtasks + macrotasks. Used after a click to let the
 * fire-and-forget onClick (copyToClipboard().then(setCopied)) settle.
 */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.mocked(copyToClipboard).mockReset();
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ChatCodeBlock — fenced code', () => {
  test('renders the raw code text inside a <code> element', () => {
    const h = mount(
      <pre>
        {renderChatCode({ className: 'language-python', children: 'print("hi")' })}
      </pre>,
    );
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toBe('print("hi")');
    expect(codeEl?.getAttribute('class')).toBe('language-python');
    unmount(h);
  });

  test('renders a Copy button inside the wrapping <pre>', () => {
    const h = mount(
      <pre>
        {renderChatCode({ children: 'hello\nworld' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy');
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toMatch(/Copy/);
    unmount(h);
  });

  test('clicking the Copy button calls copyToClipboard with the raw code', async () => {
    const h = mount(
      <pre>
        {renderChatCode({ children: 'const x = 42;\n' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    act(() => {
      btn.click();
    });
    await flush();
    expect(copyToClipboard).toHaveBeenCalledTimes(1);
    expect(copyToClipboard).toHaveBeenCalledWith('const x = 42;');
    unmount(h);
  });

  test('button text changes to "✓ Copied!" after a successful copy', async () => {
    const h = mount(
      <pre>
        {renderChatCode({ children: 'foo' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    act(() => {
      btn.click();
    });
    await flush();
    expect(btn.textContent).toMatch(/✓ Copied!/);
    expect(btn.getAttribute('data-copied')).toBe('1');
    unmount(h);
  });

  test('button text reverts to "Copy" after 2 seconds (fake timers)', async () => {
    vi.useFakeTimers();
    const h = mount(
      <pre>
        {renderChatCode({ children: 'bar' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    act(() => {
      btn.click();
    });
    // Use real timers for the copyToClipboard().then() chain, then switch
    // to fake timers so we can advance the 2s reset deterministically.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(btn.textContent).toMatch(/✓ Copied!/);
    await act(async () => {
      vi.advanceTimersByTime(2000);
    });
    expect(btn.textContent).toMatch(/^Copy$/);
    expect(btn.getAttribute('data-copied')).toBe('0');
    unmount(h);
  });

  test('a11y: button has aria-label="Copy code" and a live region for the text', () => {
    const h = mount(
      <pre>
        {renderChatCode({ children: 'x' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    expect(btn.getAttribute('aria-label')).toBe('Copy code');
    const live = btn.querySelector('[aria-live="polite"]');
    expect(live).not.toBeNull();
    unmount(h);
  });

  test('empty / whitespace-only code does NOT render a Copy button', () => {
    const h = mount(
      <pre>
        {renderChatCode({ children: '   \n  ' })}
      </pre>,
    );
    const btn = h.container.querySelector('button.chat__codecopy');
    expect(btn).toBeNull();
    // The <code> still renders with the (whitespace) text.
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    unmount(h);
  });

  test('clicking does nothing visually if copyToClipboard() returns false', async () => {
    vi.mocked(copyToClipboard).mockResolvedValueOnce(false);
    const h = mount(
      <pre>
        {renderChatCode({ children: 'failing copy' })}
      </pre>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    act(() => {
      btn.click();
    });
    await flush();
    expect(btn.textContent).toMatch(/^Copy$/);
    expect(btn.getAttribute('data-copied')).toBe('0');
    unmount(h);
  });
});

describe('ChatCodeBlock — inline code', () => {
  test('inline code is rendered as a plain <code> with no Copy button', () => {
    const h = mount(
      <span>
        {renderChatCode({ inline: true, children: 'x' })}
      </span>,
    );
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    expect(codeEl?.textContent).toBe('x');
    const btn = h.container.querySelector('button.chat__codecopy');
    expect(btn).toBeNull();
    unmount(h);
  });
});
