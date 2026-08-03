// SPDX-License-Identifier: Apache-2.0
// Pulse desktop — first-run onboarding tour tests (R161).
//
// Covers: gating on localStorage flag, skip/finish/Escape/back behaviour,
// versioned storage key, and the small pure helpers
// (isOnboardingDone / markOnboardingDone / resetOnboarding).
//
// Mount pattern follows LicenseInput.test.tsx — createRoot + act from
// react-dom/client, no @testing-library/react (not in deps).
//
// `IS_REACT_ACT_ENVIRONMENT = true` silences happy-dom's "not configured
// to support act" warning for every `act(...)` call.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import {
  Onboarding,
  isOnboardingDone,
  markOnboardingDone,
  resetOnboarding,
} from '../Onboarding';

const LS_DONE = 'pulse.onboarding.completed.v1';
const LS_DONE_TS = 'pulse.onboarding.completed.v1.ts';

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

function dispatchKey(target: Element, key: string) {
  const evt = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
  });
  act(() => {
    target.dispatchEvent(evt);
  });
}

/** Mirrors the gating logic in App.tsx — parent only renders Onboarding
 *  when `!isOnboardingDone()` is true on mount. */
function GatedOnboarding({ onDone }: { onDone: () => void }) {
  const [show, setShow] = useStateSafe(() => !isOnboardingDone());
  if (!show) return null;
  return (
    <Onboarding
      onDone={() => {
        setShow(false);
        onDone();
      }}
    />
  );
}

// Tiny inline useState helper to avoid importing React in the test
// file just for hooks (we already import act from 'react').
import { useState as useStateSafe } from 'react';

describe('Onboarding — localStorage helpers', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('isOnboardingDone returns false when no flag is set', () => {
    expect(isOnboardingDone()).toBe(false);
  });

  test('markOnboardingDone sets the versioned flag to "true"', () => {
    markOnboardingDone();
    expect(localStorage.getItem(LS_DONE)).toBe('true');
    expect(localStorage.getItem(LS_DONE_TS)).not.toBeNull();
    expect(isOnboardingDone()).toBe(true);
  });

  test('resetOnboarding clears the flag so the tour re-shows', () => {
    markOnboardingDone();
    expect(isOnboardingDone()).toBe(true);
    resetOnboarding();
    expect(isOnboardingDone()).toBe(false);
    expect(localStorage.getItem(LS_DONE)).toBeNull();
    expect(localStorage.getItem(LS_DONE_TS)).toBeNull();
  });
});

describe('Onboarding — gating on first run', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  test('first run (no localStorage flag) → modal renders', () => {
    expect(isOnboardingDone()).toBe(false);
    const h = mount(<GatedOnboarding onDone={() => {}} />);
    const modal = h.container.querySelector('[data-testid="onb-desk-modal"]');
    expect(modal).not.toBeNull();
    unmount(h);
  });

  test('already completed (flag = "true") → modal does NOT render', () => {
    markOnboardingDone();
    expect(isOnboardingDone()).toBe(true);
    const h = mount(<GatedOnboarding onDone={() => {}} />);
    const modal = h.container.querySelector('[data-testid="onb-desk-modal"]');
    expect(modal).toBeNull();
    unmount(h);
  });
});

describe('Onboarding — user flows', () => {
  let harness: Harness;
  let onDone: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    onDone = vi.fn();
    harness = mount(<Onboarding onDone={onDone} currentModel="gemma2:2b" ollamaStatus="ok" />);
  });
  afterEach(() => {
    unmount(harness);
    localStorage.clear();
  });

  test('click Skip → flag set + onDone called', () => {
    const skip = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="onb-desk-skip"]',
    );
    expect(skip).not.toBeNull();
    act(() => {
      skip!.click();
    });
    expect(localStorage.getItem(LS_DONE)).toBe('true');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('click Next through all 3 steps → flag set + onDone called', () => {
    const next = () =>
      harness.container.querySelector<HTMLButtonElement>(
        '[data-testid="onb-desk-next"]',
      )!;

    // Step 1: title should be the welcome step.
    expect(harness.container.querySelector('.onb-desk__title')?.textContent).toMatch(
      /Local AI/i,
    );

    act(() => {
      next().click();
    });
    // Step 2: model step.
    expect(harness.container.querySelector('.onb-desk__title')?.textContent).toMatch(
      /Pick your model/i,
    );
    // Back button should now exist (we left step 1).
    const back = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="onb-desk-back"]',
    );
    expect(back).not.toBeNull();

    act(() => {
      next().click();
    });
    // Step 3: chat step.
    expect(harness.container.querySelector('.onb-desk__title')?.textContent).toMatch(
      /Start chatting/i,
    );

    // Final click on "Finish" should complete.
    act(() => {
      next().click();
    });
    expect(localStorage.getItem(LS_DONE)).toBe('true');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('click Back at step 2 → returns to step 1', () => {
    // Advance to step 2.
    act(() => {
      harness.container
        .querySelector<HTMLButtonElement>('[data-testid="onb-desk-next"]')!
        .click();
    });
    expect(harness.container.querySelector('.onb-desk__title')?.textContent).toMatch(
      /Pick your model/i,
    );

    // Click back.
    act(() => {
      harness.container
        .querySelector<HTMLButtonElement>('[data-testid="onb-desk-back"]')!
        .click();
    });
    expect(harness.container.querySelector('.onb-desk__title')?.textContent).toMatch(
      /Local AI/i,
    );
    // Skip button is back (we're on step 1).
    expect(
      harness.container.querySelector('[data-testid="onb-desk-skip"]'),
    ).not.toBeNull();
  });

  test('press Escape → modal closes via skip behaviour', () => {
    const modal = harness.container.querySelector<HTMLElement>(
      '[data-testid="onb-desk-modal"]',
    )!;
    dispatchKey(modal, 'Escape');
    expect(localStorage.getItem(LS_DONE)).toBe('true');
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  test('uses versioned localStorage key pulse.onboarding.completed.v1', () => {
    act(() => {
      harness.container
        .querySelector<HTMLButtonElement>('[data-testid="onb-desk-skip"]')!
        .click();
    });
    // The unversioned key MUST NOT be set — only the versioned one.
    expect(localStorage.getItem('pulse.onboarding.completed')).toBeNull();
    expect(localStorage.getItem('pulse.onboarding.done')).toBeNull();
    expect(localStorage.getItem(LS_DONE)).toBe('true');
  });
});
