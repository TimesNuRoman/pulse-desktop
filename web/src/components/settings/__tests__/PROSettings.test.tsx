// SPDX-License-Identifier: Apache-2.0
// Pulse — PROSettings component tests (R191 trial rewrite).
//
// Covers the four R191 render states by mocking the `licenseStore`
// module before the component imports it:
//   * 'trial'         → countdown + "Upgrade to PRO" CTA + feature list
//   * 'expired'       → "Trial ended" pill + LicenseInput
//   * 'valid'         → license info + "Manage subscription" + Deactivate
//   * 'offline-grace' → warn banner + "Revalidate" / "Deactivate"
//
// The `window.open` spy intercepts the "Upgrade to PRO" link so we
// can assert the checkout URL is wired without leaving the test env.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';

// Mock the store module before importing the component. We do this
// with vi.mock + a hoisted factory so the component sees a stub
// `licenseStore` whose state we control per-test.
const { stateRef, mockStore, openSpy } = vi.hoisted(() => {
  const stateRef: { current: any } = { current: null };
  const listeners = new Set<(l: any) => void>();
  const mockStore = {
    current: () => stateRef.current,
    subscribe: (l: (l: any) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    setKey: vi.fn(async () => stateRef.current),
    clear: vi.fn(async () => {
      /* no-op for tests */
    }),
    startTrial: vi.fn(async () => stateRef.current),
  };
  const openSpy = vi.fn();
  return { stateRef, mockStore, openSpy };
});

vi.mock('../../../lib/license/store', () => ({
  licenseStore: mockStore,
}));

// Stub window.open so the "Upgrade to PRO" button doesn't pop a real tab.
beforeEach(() => {
  (window as any).open = openSpy;
  openSpy.mockReset();
  mockStore.setKey.mockReset();
  mockStore.clear.mockReset();
  mockStore.startTrial.mockReset();
  stateRef.current = null;
});

import { PROSettings } from '../PROSettings';

interface Harness {
  root: Root;
  container: HTMLDivElement;
}

function mount(): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<PROSettings />);
  });
  return { root, container };
}

function unmount(h: Harness) {
  act(() => {
    h.root.unmount();
  });
  document.body.removeChild(h.container);
}

function setLicense(state: any) {
  stateRef.current = state;
}

describe('PROSettings — R191 trial state', () => {
  let harness: Harness;

  beforeEach(() => {
    setLicense({
      key: '',
      status: 'trial',
      tier: 'pro',
      expiresAt: null,
      lastValidated: 0,
      trialStartedAt: Date.now() - 24 * 60 * 60 * 1000, // 1 day ago → 13d left
    });
    harness = mount();
  });

  afterEach(() => {
    unmount(harness);
  });

  test('renders the trial countdown', () => {
    const countdown = harness.container.querySelector(
      '[data-testid="trial-countdown"]',
    );
    expect(countdown).not.toBeNull();
    expect(countdown?.textContent).toMatch(/13 days left/);
  });

  test('renders an "Upgrade to PRO" CTA with a checkout link', () => {
    const btn = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="pro-upgrade-btn"]',
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toMatch(/Upgrade to PRO/);
    act(() => {
      btn!.click();
    });
    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(openSpy.mock.calls[0][0]).toMatch(/nowpayments\.io/);
  });

  test('renders the PRO feature list', () => {
    const features = harness.container.querySelectorAll('.pro-settings__feature');
    expect(features.length).toBeGreaterThan(0);
  });
});

describe('PROSettings — R191 expired state', () => {
  let harness: Harness;

  beforeEach(() => {
    setLicense({
      key: '',
      status: 'expired',
      tier: 'pro',
      expiresAt: null,
      lastValidated: 0,
      trialStartedAt: Date.now() - 30 * 24 * 60 * 60 * 1000,
    });
    harness = mount();
  });

  afterEach(() => {
    unmount(harness);
  });

  test('renders "Trial ended" pill', () => {
    const pill = harness.container.querySelector('.pro-settings__pill--expired');
    expect(pill).not.toBeNull();
    expect(pill?.textContent).toMatch(/Trial ended/);
  });

  test('renders LicenseInput so the user can activate', () => {
    const input = harness.container.querySelector('.license-input');
    expect(input).not.toBeNull();
  });

  test('renders "Upgrade" CTA that opens the checkout URL', () => {
    const upgrades = harness.container.querySelectorAll<HTMLButtonElement>(
      '.pro-settings__btn--primary',
    );
    expect(upgrades.length).toBeGreaterThan(0);
    act(() => {
      upgrades[0].click();
    });
    expect(openSpy).toHaveBeenCalled();
  });
});

describe('PROSettings — R191 valid PRO state', () => {
  let harness: Harness;

  beforeEach(() => {
    setLicense({
      key: 'PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD',
      status: 'valid',
      tier: 'pro',
      expiresAt: null,
      lastValidated: Date.now(),
      trialStartedAt: null,
    });
    harness = mount();
  });

  afterEach(() => {
    unmount(harness);
  });

  test('renders the masked license key', () => {
    const key = harness.container.querySelector('.pro-settings__key');
    expect(key).not.toBeNull();
    expect(key?.textContent).toContain('PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD');
  });

  test('renders "Manage subscription" CTA', () => {
    const btn = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /Manage subscription/i.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
  });

  test('clicking "Deactivate" calls licenseStore.clear()', async () => {
    const btn = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /Deactivate/i.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
    await act(async () => {
      btn!.click();
    });
    expect(mockStore.clear).toHaveBeenCalledTimes(1);
  });
});

describe('PROSettings — R191 offline-grace state', () => {
  let harness: Harness;

  beforeEach(() => {
    setLicense({
      key: 'PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD',
      status: 'offline-grace',
      tier: 'pro',
      expiresAt: null,
      lastValidated: Date.now() - 30 * 24 * 60 * 60 * 1000,
      trialStartedAt: null,
    });
    harness = mount();
  });

  afterEach(() => {
    unmount(harness);
  });

  test('renders the warn banner with role=status', () => {
    const banner = harness.container.querySelector('[role="status"]');
    expect(banner).not.toBeNull();
    expect(banner?.textContent).toMatch(/grace period/i);
  });

  test('renders a "Revalidate" button', () => {
    const btn = Array.from(
      harness.container.querySelectorAll<HTMLButtonElement>('button'),
    ).find((b) => /Revalidate/i.test(b.textContent ?? ''));
    expect(btn).toBeDefined();
  });
});
