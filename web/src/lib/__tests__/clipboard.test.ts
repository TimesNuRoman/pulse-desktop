// SPDX-License-Identifier: Apache-2.0
// Tests for the clipboard helper (R176).
//
// Covers the two paths: modern navigator.clipboard.writeText and the
// legacy document.execCommand('copy') fallback. happy-dom provides
// navigator.clipboard as undefined by default, so we install mocks
// per-test.

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { copyToClipboard } from '../clipboard';

describe('copyToClipboard — modern path', () => {
  let writeText: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis, 'navigator', {
      value: { clipboard: { writeText } },
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls navigator.clipboard.writeText with the exact text', async () => {
    await copyToClipboard('hello world');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(writeText).toHaveBeenCalledWith('hello world');
  });

  test('returns true on success', async () => {
    const ok = await copyToClipboard('anything');
    expect(ok).toBe(true);
  });

  test('falls through to legacy when modern API rejects', async () => {
    writeText.mockRejectedValueOnce(new Error('permission denied'));
    const exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: exec,
      configurable: true,
      writable: true,
    });
    const ok = await copyToClipboard('fallback me');
    expect(writeText).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('copy');
    expect(ok).toBe(true);
  });
});

describe('copyToClipboard — legacy fallback', () => {
  let exec: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Strip the modern API so we go straight to execCommand.
    Object.defineProperty(globalThis, 'navigator', {
      value: {},
      configurable: true,
      writable: true,
    });
    exec = vi.fn().mockReturnValue(true);
    Object.defineProperty(document, 'execCommand', {
      value: exec,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('uses document.execCommand("copy") when navigator.clipboard is missing', async () => {
    const ok = await copyToClipboard('legacy text');
    expect(exec).toHaveBeenCalledWith('copy');
    expect(ok).toBe(true);
  });

  test('returns false when both modern and legacy paths fail', async () => {
    exec.mockReturnValue(false);
    const ok = await copyToClipboard('nope');
    expect(ok).toBe(false);
  });
});
