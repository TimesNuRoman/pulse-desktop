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
import { ProRequiredError } from '../types';

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

  test('clear → load returns empty (free) license', async () => {
    await licenseStore.setKey(TEST_KEY);
    expect(licenseStore.current().tier).toBe('pro');
    await licenseStore.clear();
    expect(licenseStore.current().tier).toBe('free');
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
