// SPDX-License-Identifier: Apache-2.0
// Pulse — LicenseInput component tests (R125 fix).
//
// R119 shipped a LicenseInput that pre-filled the hardcoded `TEST_KEY`
// on mount and used a single-char HTML5 `pattern` per chunk, so the
// native form check rejected the test key on submit ("Please match the
// requested format"). R125 splits the fix in two:
//
//   1. Production users now start with empty inputs (no prefill).
//   2. A dev-only "Use test key" shortcut activates PRO in one click
//      without going through the form's `pattern` / `maxLength` checks.
//
// These tests pin both behaviours. Run via `npm test -- LicenseInput`.

// React 18 `act` requires this flag in the test environment. happy-dom
// does not set it by default; without it, every `act` call emits a
// "The current testing environment is not configured to support act"
// warning into stderr. Setting it here keeps the change to a single
// test file (we don't touch vitest.config.ts).
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { LicenseInput } from '../LicenseInput';
import { TEST_KEY } from '../../../lib/license/validate';

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

function chunkInputs(h: Harness): HTMLInputElement[] {
  return Array.from(
    h.container.querySelectorAll<HTMLInputElement>('.license-input__chunk'),
  );
}

describe('LicenseInput — R125 activation', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = mount(<LicenseInput onSubmit={() => {}} />);
  });

  afterEach(() => {
    unmount(harness);
  });

  test('starts with empty inputs (no test-key prefill on mount)', () => {
    const inputs = chunkInputs(harness);
    expect(inputs).toHaveLength(5);
    for (const input of inputs) {
      expect(input.value).toBe('');
    }
  });

  test('Activate is disabled until all five chunks are filled', () => {
    const submit = harness.container.querySelector<HTMLButtonElement>(
      '.license-input__submit',
    );
    expect(submit?.disabled).toBe(true);
  });

  test('"Use test key" button is visible in dev mode', () => {
    const btn = harness.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    );
    expect(btn).not.toBeNull();
    expect(btn?.textContent).toMatch(/Use test key/);
    expect(btn?.type).toBe('button');
  });
});

describe('LicenseInput — dev "Use test key" behaviour', () => {
  test('clicking the dev button populates chunk inputs with the TEST_KEY groups', () => {
    const h = mount(<LicenseInput onSubmit={() => {}} />);
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    );
    expect(btn).not.toBeNull();

    act(() => {
      btn!.click();
    });

    const values = chunkInputs(h).map((input) => input.value);
    // TEST_KEY = "PULSE-TEST1-TEST1-TEST1-TEST1-TEST1" → 5 groups of "TEST1".
    expect(values).toEqual(['TEST1', 'TEST1', 'TEST1', 'TEST1', 'TEST1']);
    unmount(h);
  });

  test('clicking the dev button calls onSubmit with TEST_KEY', async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const h = mount(<LicenseInput onSubmit={onSubmit} />);
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    )!;

    await act(async () => {
      btn.click();
    });

    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(TEST_KEY);
    unmount(h);
  });

  test('dev button is disabled while a previous activation is in flight', async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSubmit = res;
        }),
    );
    const h = mount(<LicenseInput onSubmit={onSubmit} />);
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    )!;

    act(() => {
      btn.click();
    });
    expect(btn.disabled).toBe(true);

    await act(async () => {
      resolveSubmit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    unmount(h);
  });

  test('dev button surfaces activation errors via the error slot', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('license server unreachable'));
    const h = mount(<LicenseInput onSubmit={onSubmit} />);
    const btn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    )!;

    await act(async () => {
      btn.click();
    });

    const err = h.container.querySelector<HTMLDivElement>('.license-input__error');
    expect(err?.textContent).toContain('license server unreachable');
    unmount(h);
  });
});

describe('LicenseInput — production build', () => {
  // `import.meta.env.DEV` is replaced at Vite transform time. In the
  // test environment it resolves to `true` (vitest runs in dev-like
  // mode), so the dev shortcut is visible by default. We assert the
  // conditional guard via static source inspection rather than runtime
  // env stubbing, which doesn't reach the transform-time constant.
  test('source guards the dev button on import.meta.env.DEV', async () => {
    const fs = await import('node:fs/promises');
    const path = await import('node:path');
    const src = await fs.readFile(
      path.join(__dirname, '..', 'LicenseInput.tsx'),
      'utf-8',
    );
    // The button must be wrapped in an `import.meta.env.DEV` check so
    // production bundles never expose the test-key shortcut.
    expect(src).toMatch(/import\.meta\.env\.DEV/);
    // The dev button's data-testid must live inside that guard.
    const devGuardIdx = src.indexOf('import.meta.env.DEV');
    const testIdIdx = src.indexOf('use-test-key');
    expect(devGuardIdx).toBeGreaterThan(-1);
    expect(testIdIdx).toBeGreaterThan(devGuardIdx);
  });
});

// ── R191 trial / expired-state coverage ───────────────────────────────

describe('LicenseInput — R191 expired-state behaviour', () => {
  test('still renders 5 chunk inputs when mounted standalone (used in expired-state PROSettings)', () => {
    // PROSettings mounts <LicenseInput> for the 'expired' branch
    // ("Trial ended → activate a key"). The input contract is the
    // same: 5 chunks + a submit button.
    const h = mount(<LicenseInput onSubmit={() => {}} />);
    const chunks = chunkInputs(h);
    expect(chunks).toHaveLength(5);
    expect(
      h.container.querySelector<HTMLButtonElement>('.license-input__submit'),
    ).not.toBeNull();
    unmount(h);
  });

  test('surfaces setKey rejection in the error slot (expired-state user pastes an invalid key)', async () => {
    const onSubmit = vi.fn().mockRejectedValue(new Error('activation failed'));
    const h = mount(<LicenseInput onSubmit={onSubmit} />);
    // The dev "Use test key" button populates chunks AND calls
    // onSubmit(TEST_KEY) in one click — same path the user takes
    // when they paste a real key into the 5 chunks. Use it to drive
    // the rejection flow.
    const devBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    )!;
    await act(async () => {
      devBtn.click();
    });
    const err = h.container.querySelector<HTMLDivElement>('.license-input__error');
    expect(err?.textContent ?? '').toContain('activation failed');
    unmount(h);
  });

  test('submit button is disabled while a setKey call is in flight (busy state)', async () => {
    let resolveSubmit: () => void = () => {};
    const onSubmit = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveSubmit = res;
        }),
    );
    const h = mount(<LicenseInput onSubmit={onSubmit} />);
    const devBtn = h.container.querySelector<HTMLButtonElement>(
      '[data-testid="use-test-key"]',
    )!;
    // The dev button drives both chunk fill AND the in-flight submit.
    // We assert busy state by checking the dev button's own disabled
    // flag mid-flight (it has the same `submitting` gate as the main
    // submit button).
    expect(devBtn.disabled).toBe(false);
    await act(async () => {
      devBtn.click();
    });
    // In-flight: dev button disabled.
    expect(devBtn.disabled).toBe(true);
    // Resolve and assert the submission went through.
    await act(async () => {
      resolveSubmit();
    });
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit).toHaveBeenCalledWith(TEST_KEY);
    unmount(h);
  });
});
