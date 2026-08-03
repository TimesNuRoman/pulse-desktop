// SPDX-License-Identifier: Apache-2.0
// Integration test: ChatView renders a fenced code block with a Copy button
// and the button works end-to-end (R176).
//
// We do NOT import the full ChatView (it pulls in Tauri APIs, the LLM
// client, the agent loop, etc.). Instead we replicate the exact wiring
// that ChatView uses: `<ReactMarkdown components={{ code: renderChatCode }}>`.
// This proves the integration contract: a fenced ```python\n...``` block
// in chat markdown becomes a <pre> with a working Copy button.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderChatCode } from '../ChatCodeBlock';

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

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  vi.mocked(copyToClipboard).mockReset();
  vi.mocked(copyToClipboard).mockResolvedValue(true);
});

describe('ChatView code-block integration (R176)', () => {
  test('a ```python block renders with a Copy button', () => {
    const h = mount(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ code: renderChatCode }}
      >
        {'```python\nprint("hi")\n```'}
      </ReactMarkdown>,
    );
    const pre = h.container.querySelector('pre');
    const code = h.container.querySelector('code');
    expect(pre).not.toBeNull();
    expect(code).not.toBeNull();
    expect(code?.className).toBe('language-python');
    expect(code?.textContent).toContain('print("hi")');
    const btn = pre?.querySelector('button.chat__codecopy');
    expect(btn).not.toBeNull();
    expect(btn?.getAttribute('aria-label')).toBe('Copy code');
    unmount(h);
  });

  test('clicking the Copy button shows "Copied!" inline', async () => {
    const h = mount(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ code: renderChatCode }}
      >
        {'```js\nconst a = 1;\n```'}
      </ReactMarkdown>,
    );
    const btn = h.container.querySelector<HTMLButtonElement>('button.chat__codecopy')!;
    act(() => {
      btn.click();
    });
    await flush();
    expect(copyToClipboard).toHaveBeenCalledWith('const a = 1;');
    expect(btn.textContent).toMatch(/✓ Copied!/);
    unmount(h);
  });

  test('two fenced blocks render with INDEPENDENT copy buttons', async () => {
    const h = mount(
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{ code: renderChatCode }}
      >
        {'```py\nfirst\n```\n\n```js\nsecond\n```'}
      </ReactMarkdown>,
    );
    const btns = h.container.querySelectorAll<HTMLButtonElement>('button.chat__codecopy');
    expect(btns).toHaveLength(2);

    act(() => {
      btns[0].click();
    });
    await flush();

    // First block shows "Copied!" — second block is still "Copy".
    expect(btns[0].textContent).toMatch(/✓ Copied!/);
    expect(btns[1].textContent).toMatch(/^Copy$/);

    // And the second block was not copied when the first was clicked.
    const calls = vi.mocked(copyToClipboard).mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0][0]).toBe('first');

    // Now click the second one — its state updates independently.
    act(() => {
      btns[1].click();
    });
    await flush();
    expect(btns[1].textContent).toMatch(/✓ Copied!/);
    const calls2 = vi.mocked(copyToClipboard).mock.calls;
    expect(calls2).toHaveLength(2);
    expect(calls2[1][0]).toBe('second');
    unmount(h);
  });
});
