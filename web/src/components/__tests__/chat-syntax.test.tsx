// SPDX-License-Identifier: Apache-2.0
// Pulse — chat code-block integration tests (R168').
//
// Verifies that the `code` override used by the chat markdown renderer
// correctly:
//   1. highlights fenced ```python blocks (tok-str + tok-fn spans)
//   2. renders fenced ```unknown blocks as plain escaped text
//   3. does NOT highlight inline `code` (single backticks)
//
// We exercise both the standalone renderCode component and a real
// react-markdown instance, so any regression in the integration
// (e.g. the components prop wiring) shows up.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { renderCode } from '../CodeBlock';

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

/** Render a markdown string through the same `code` override the chat uses. */
function renderMarkdown(md: string): Harness {
  return mount(
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ code: renderCode }}>
      {md}
    </ReactMarkdown>,
  );
}

describe('chat code block — renderCode (standalone)', () => {
  test('fenced python block: string + function name are wrapped in tok spans', () => {
    const h = mount(
      <pre>
        {renderCode({ className: 'language-python', children: 'print("hi")' })}
      </pre>,
    );
    // renderCode should emit the inner <code> as a child of the surrounding
    // <pre>. We look at the <code> for our spans.
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    // Function: `print` is a Python builtin → tok-fn.
    expect(codeEl!.innerHTML).toMatch(/<span class="tok-fn">print<\/span>/);
    // String span exists (quote is a DOM char; happy-dom may serialize
    // innerHTML without escaping `"`).
    expect(codeEl!.innerHTML).toMatch(/<span class="tok-str">["']hi["']<\/span>/);
    // a11y: <code> carries lang and aria-label.
    expect(codeEl!.getAttribute('lang')).toBe('python');
    expect(codeEl!.getAttribute('aria-label')).toBe('python code block');
    unmount(h);
  });

  test('fenced unknown language: rendered as plain escaped text, NO spans', () => {
    const h = mount(
      <pre>
        {renderCode({ className: 'language-html', children: '<script>' })}
      </pre>,
    );
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    // No token spans for unknown languages.
    expect(codeEl!.innerHTML).not.toContain('tok-');
    // React escapes < > at render time.
    expect(codeEl!.textContent).toBe('<script>');
    // Still has the aria-label for a11y.
    expect(codeEl!.getAttribute('aria-label')).toBe('html code block');
    unmount(h);
  });

  test('inline code: NOT highlighted, no spans', () => {
    const h = mount(renderCode({ inline: true, children: '`print("hi")`' }));
    const codeEl = h.container.querySelector('code');
    expect(codeEl).not.toBeNull();
    expect(codeEl!.innerHTML).not.toContain('tok-');
    // Inline code is passed through as React text — no language class
    // is required.
    expect(codeEl!.textContent).toBe('`print("hi")`');
    unmount(h);
  });
});

describe('chat code block — react-markdown integration', () => {
  // vi.spyOn returns a MockInstance with vitest-specific generics that
  // are awkward to type. Local helper:
  //   eslint-disable-next-line @typescript-eslint/no-explicit-any
  let consoleErrorSpy: any;

  beforeEach(() => {
    // react-markdown may log a deprecation warning or a missing-prop
    // notice in some setups. We don't want those to fail the run.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('fenced ```python renders with token spans inside the <pre><code>', () => {
    const h = renderMarkdown('```python\nprint("hi")\n```');
    const pre = h.container.querySelector('pre');
    const code = pre?.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('language-python');
    expect(code!.innerHTML).toMatch(/<span class="tok-fn">print<\/span>/);
    // The string literal "hi" gets a tok-str span (quote may be
    // serialized as raw " or as &quot; depending on the DOM).
    expect(code!.innerHTML).toMatch(/<span class="tok-str">["']hi["']<\/span>/);
    unmount(h);
  });

  test('fenced ```unknown renders as plain escaped text, no spans', () => {
    const h = renderMarkdown('```unknown\nfoo bar\n```');
    const pre = h.container.querySelector('pre');
    const code = pre?.querySelector('code');
    expect(code).not.toBeNull();
    expect(code!.className).toContain('language-unknown');
    expect(code!.innerHTML).not.toContain('tok-');
    expect(code!.textContent).toBe('foo bar');
    unmount(h);
  });

  test('inline `code` is NOT highlighted, no spans', () => {
    const h = renderMarkdown('Use `print("hi")` to log.');
    const inline = h.container.querySelector('p code');
    expect(inline).not.toBeNull();
    expect(inline!.innerHTML).not.toContain('tok-');
    // Text content includes the backticks because the inline code's
    // children is passed through verbatim.
    expect(inline!.textContent).toContain('print');
    unmount(h);
  });
});
