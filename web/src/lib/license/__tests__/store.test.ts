// SPDX-License-Identifier: Apache-2.0
// Tests for the license store (R119 PRO foundation).
//
// We stub `invoke` (Tauri) before importing the store so the store runs in a
// Tauri-like environment. The store uses an in-memory map as the "disk".

import { describe, test, expect, beforeEach, vi } from 'vitest';

// `vi.mock` is hoisted to the top of the file, before any imports. Variables
// referenced in the mock factory must be created with `vi.hoisted` to be
// accessible from the hoisted mock callback.
const { memStore, invokeMock } = vi.hoisted(() => {
  const memStore = new Map<string, Uint8Array>();
  const invokeMock = vi.fn(async (cmd: string, args?: any) => {
    if (cmd === 'license_read') {
      const v = memStore.get('license.bin');
      return v ? Array.from(v) : null;
    }
    if (cmd === 'license_write') {
      const u8 = new Uint8Array(args?.bytes ?? []);
      memStore.set('license.bin', u8);
      return null;
    }
    if (cmd === 'license_clear') {
      memStore.delete('license.bin');
      return null;
    }
    return null;
  });
  return { memStore, invokeMock };
});

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

// Tell the store we're in a Tauri context. happy-dom already provides
// `window`; we just need to set the marker.
beforeEach(() => {
  memStore.clear();
  invokeMock.mockClear();
  (window as any).__TAURI_INTERNALS__ = {};
});

import { licenseStore } from '../store';
import { TEST_KEY } from '../validate';
import { decryptLicense } from '../crypto';
import { ProRequiredError, TRIAL_DURATION_MS } from '../types';

describe('store — setKey / load / clear', () => {
  test('setKey → load returns the same license', async () => {
    await licenseStore.clear();
    await licenseStore.setKey(TEST_KEY);
    const after = licenseStore.current();
    expect(after.tier).toBe('pro');
    expect(after.key).toBe(TEST_KEY);
    expect(after.status).toBe('valid');

    // Reload from disk to verify persistence path.
    const enc = memStore.get('license.bin');
    expect(enc).toBeDefined();
    const dec = await decryptLicense(enc!);
    expect(dec.key).toBe(TEST_KEY);
  });

  test('clear → load returns empty (no-trial-started) license', async () => {
    // R191: tier is always 'pro' (or 'free' on expired paid licenses).
    // The pre-trial state is `status='none'`, `trialStartedAt=null`.
    // After clear(), the in-memory state should match EMPTY_LICENSE.
    await licenseStore.setKey(TEST_KEY);
    expect(licenseStore.current().status).toBe('valid');
    await licenseStore.clear();
    expect(licenseStore.current().status).toBe('none');
    expect(licenseStore.current().trialStartedAt).toBeNull();
    expect(licenseStore.current().key).toBe('');
  });

  test('isPro reflects current state', async () => {
    await licenseStore.clear();
    expect(licenseStore.isPro()).toBe(false);
    await licenseStore.setKey(TEST_KEY);
    expect(licenseStore.isPro()).toBe(true);
    await licenseStore.clear();
    expect(licenseStore.isPro()).toBe(false);
  });
});

describe('store — gates', () => {
  test('free user is blocked from PRO features', async () => {
    await licenseStore.clear();
    expect(licenseStore.isPro()).toBe(false);
    expect(() => licenseStore.requirePro('code-intel')).toThrow(ProRequiredError);
  });

  test('pro user passes requirePro for all v0.6.7 features', async () => {
    await licenseStore.setKey(TEST_KEY);
    expect(licenseStore.isPro()).toBe(true);
    expect(() => licenseStore.requirePro('code-intel')).not.toThrow();
    expect(() => licenseStore.requirePro('voice-input')).not.toThrow();
    expect(() => licenseStore.requirePro('web-search')).not.toThrow();
    expect(() => licenseStore.requirePro('multi-model')).not.toThrow();
  });
});

// ── R191 trial flow ──────────────────────────────────────────────────

describe('store — R191 trial flow', () => {
  test('load() auto-starts trial for a fresh install (no disk record)', async () => {
    await licenseStore.clear();
    // clear() resets the loadPromise cache, so the next load() runs a
    // real cold-start against the (now-empty) memStore and triggers
    // the trial auto-start.
    const r = await licenseStore.load();
    expect(r.status).toBe('trial');
    expect(r.trialStartedAt).not.toBeNull();
    expect(r.tier).toBe('pro');
    expect(licenseStore.isPro()).toBe(true);
  });

  test('isPro() returns true for a fresh trial', async () => {
    await licenseStore.clear();
    await licenseStore.load();
    const s = licenseStore.current();
    expect(s.status).toBe('trial');
    expect(licenseStore.isPro()).toBe(true);
  });

  test('startTrial() is idempotent — second call does not reset the clock', async () => {
    await licenseStore.clear();
    await licenseStore.load();
    const t1 = licenseStore.current().trialStartedAt;
    expect(t1).not.toBeNull();
    // Wait a tiny bit to ensure Date.now() would differ if the clock reset.
    await new Promise((r) => setTimeout(r, 5));
    const t2 = (await licenseStore.startTrial()).trialStartedAt;
    expect(t2).toBe(t1);
  });

  test('startTrial() never overwrites a valid PRO license', async () => {
    await licenseStore.clear();
    await licenseStore.setKey(TEST_KEY);
    const before = licenseStore.current();
    expect(before.status).toBe('valid');
    const after = await licenseStore.startTrial();
    expect(after.status).toBe('valid');
    expect(after.key).toBe(TEST_KEY);
  });

  test('clear() resets to EMPTY_LICENSE; next load() starts a fresh trial', async () => {
    await licenseStore.setKey(TEST_KEY);
    expect(licenseStore.current().status).toBe('valid');
    await licenseStore.clear();
    expect(licenseStore.current().status).toBe('none');
    expect(licenseStore.current().trialStartedAt).toBeNull();
    // Re-load should start a fresh trial.
    const after = await licenseStore.load();
    expect(after.status).toBe('trial');
    expect(after.trialStartedAt).not.toBeNull();
  });

  test('setKey() during trial upgrades to PRO and preserves trialStartedAt', async () => {
    await licenseStore.clear();
    await licenseStore.load();
    const trialStart = licenseStore.current().trialStartedAt;
    expect(trialStart).not.toBeNull();
    await licenseStore.setKey(TEST_KEY);
    const after = licenseStore.current();
    expect(after.status).toBe('valid');
    expect(after.tier).toBe('pro');
    expect(after.trialStartedAt).toBe(trialStart);
    expect(licenseStore.isPro()).toBe(true);
  });

  test('applyGrace transitions an expired trial to status=expired', async () => {
    // Use the private method via a manual state mutation by going
    // through `setState`. Since `setState` is private, exercise it
    // through the public path: hand-craft a license object, then call
    // load() with the on-disk shape set up via the encrypted blob path.
    // Simpler: directly call into the store by clearing state and
    // constructing a License that's already expired.
    await licenseStore.clear();
    // Inject an "already expired trial" by setting the store's state
    // via a `setKey` chain — but the public API doesn't expose that.
    // Instead, write a trial-shape blob with trialStartedAt far in the
    // past directly to memStore, decrypt it, then call load.
    // We bypass decryptLicense by re-using encryptLicense: that's the
    // private path. So instead, simulate by calling startTrial then
    // monkey-patching Date.now() is not possible in vitest without
    // vi.useFakeTimers. Use the fake-timer API.
    vi.useFakeTimers();
    try {
      await licenseStore.clear();
      const t0 = new Date('2026-01-01T00:00:00Z').getTime();
      vi.setSystemTime(t0);
      await licenseStore.startTrial();
      // Jump past the 14-day boundary.
      vi.setSystemTime(t0 + TRIAL_DURATION_MS + 1);
      // isPro should now be false (trial elapsed).
      expect(licenseStore.isPro()).toBe(false);
      // And a fresh load() applies grace → status=expired.
      const after = await licenseStore.load();
      expect(after.status).toBe('expired');
      expect(after.tier).toBe('pro');
    } finally {
      vi.useRealTimers();
    }
  });
});
