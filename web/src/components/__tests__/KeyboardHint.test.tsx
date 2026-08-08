// SPDX-License-Identifier: Apache-2.0
// Tests for R244 KeyboardHint chip.
//
// We don't need a full DOM harness for this one - the component
// is purely presentational and the props are simple strings. We
// still use createRoot so the rendered output goes through React
// (catches accidental JSX / React import mistakes that would
// otherwise only surface in a build).

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { KeyboardHint } from '../KeyboardHint';

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

describe('KeyboardHint - rendering', () => {
  test('renders the keys in order, each wrapped in a <kbd>', () => {
    const h = mount(<KeyboardHint keys={['⌘', 'K']} ariaLabel="Open search" />);
    const kbds = h.container.querySelectorAll('kbd');
    expect(kbds).toHaveLength(2);
    expect(kbds[0].textContent).toBe('⌘');
    expect(kbds[1].textContent).toBe('K');
    unmount(h);
  });

  test('aria-label is required and is set on the chip root', () => {
    const h = mount(
      <KeyboardHint keys={['Enter']} ariaLabel="Send message" testId="hint" />,
    );
    const root = h.container.querySelector('[data-testid="hint"]')!;
    expect(root.getAttribute('aria-label')).toBe('Send message');
    expect(root.getAttribute('role')).toBe('img');
    unmount(h);
  });

  test('renders an optional leading label separated by a dot', () => {
    const h = mount(
      <KeyboardHint keys={['↵']} label="Run" ariaLabel="Run selected" />,
    );
    const text = h.container.textContent ?? '';
    expect(text).toMatch(/Run/);
    expect(text).toMatch(/·/);
    expect(text).toMatch(/↵/);
    unmount(h);
  });

  test('returns null for an empty keys array (no chip rendered)', () => {
    const h = mount(<KeyboardHint keys={[]} ariaLabel="Nothing" testId="hint" />);
    const root = h.container.querySelector('[data-testid="hint"]');
    expect(root).toBeNull();
    unmount(h);
  });
});

describe('KeyboardHint - size and accessibility', () => {
  test('minHeight and minWidth are at least 22px to stay a real hit target', () => {
    const h = mount(<KeyboardHint keys={['⌘', 'K']} ariaLabel="Search" />);
    const root = h.container.firstElementChild as HTMLElement;
    const cs = window.getComputedStyle(root);
    // happy-dom returns '22px' for these.
    expect(cs.minHeight).toBe('22px');
    expect(cs.minWidth).toBe('22px');
    unmount(h);
  });

  test('no emoji codepoints in the rendered text', () => {
    // The Raycast-style keys (⌘, ↵, ⌫) are Unicode symbols, not
    // emoji - they live in the U+2300..U+23FF range. We only
    // forbid the actual emoji blocks. (This is a regression net
    // for accidental copy-paste of decorative emoji like ⭐️.)
    const h = mount(
      <KeyboardHint keys={['⌘', 'K']} label="Run" ariaLabel="Run selected" />,
    );
    const text = h.container.textContent ?? '';
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
    unmount(h);
  });
});
