// SPDX-License-Identifier: Apache-2.0
// Tests for R244 EmptyState component.
//
// Covers the three illustration variants, the title/hint rendering,
// the aria-hidden contract on the SVG, and the no-emoji rule.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { EmptyState } from '../EmptyState';

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

describe('EmptyState - rendering', () => {
  test('renders the title', () => {
    const h = mount(<EmptyState title="No saved chats yet" />);
    const text = h.container.textContent ?? '';
    expect(text).toMatch(/No saved chats yet/);
    unmount(h);
  });

  test('renders the optional hint when provided', () => {
    const h = mount(
      <EmptyState title="Empty" hint="Press the plus button to start." />,
    );
    const text = h.container.textContent ?? '';
    expect(text).toMatch(/Press the plus button to start\./);
    unmount(h);
  });

  test('omits the hint paragraph when not provided (no empty <p>)', () => {
    const h = mount(<EmptyState title="Empty" />);
    const ps = h.container.querySelectorAll('p');
    expect(ps).toHaveLength(1);
    unmount(h);
  });
});

describe('EmptyState - illustration', () => {
  test('default illustration is a 64x64 paper-plane SVG', () => {
    const h = mount(<EmptyState title="Empty" testId="es" />);
    const svg = h.container.querySelector('svg.empty-state__float')!;
    expect(svg).not.toBeNull();
    const cs = window.getComputedStyle(svg);
    expect(cs.width).toBe('64px');
    expect(cs.height).toBe('64px');
    expect(svg.getAttribute('aria-hidden')).not.toBeNull();
    unmount(h);
  });

  test('illustration="circle" swaps in a nested-circle SVG', () => {
    const h = mount(
      <EmptyState title="Empty" illustration="circle" testId="es" />,
    );
    const svg = h.container.querySelector('svg.empty-state__float')!;
    const circles = svg.querySelectorAll('circle');
    expect(circles.length).toBeGreaterThanOrEqual(2);
    unmount(h);
  });

  test('illustration="square" swaps in a rounded-square SVG', () => {
    const h = mount(
      <EmptyState title="Empty" illustration="square" testId="es" />,
    );
    const svg = h.container.querySelector('svg.empty-state__float')!;
    const rect = svg.querySelector('rect');
    expect(rect).not.toBeNull();
    expect(svg.querySelector('circle')).toBeNull();
    unmount(h);
  });

  test('illustration SVG has the float class so the 4s animation kicks in', () => {
    const h = mount(<EmptyState title="Empty" />);
    const svg = h.container.querySelector('svg.empty-state__float');
    expect(svg).not.toBeNull();
    unmount(h);
  });
});

describe('EmptyState - hygiene', () => {
  test('no emoji in the rendered output', () => {
    const h = mount(
      <EmptyState title="Empty" hint="Try again later" />,
    );
    const text = h.container.textContent ?? '';
    expect(text).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u);
    unmount(h);
  });
});
