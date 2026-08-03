// SPDX-License-Identifier: Apache-2.0
// Tests for license payload encryption (R119 PRO foundation).
//
// Roundtrip: encrypt → decrypt yields the same object. AES-GCM tag
// validation = tamper detection (corrupt the bytes, decrypt throws).

import { describe, test, expect } from 'vitest';
import { encryptLicense, decryptLicense } from '../crypto';
import { EMPTY_LICENSE } from '../types';
import type { License } from '../types';

describe('crypto — AES-GCM roundtrip', () => {
  test('roundtrips an empty license', async () => {
    const enc = await encryptLicense(EMPTY_LICENSE);
    expect(enc).toBeInstanceOf(Uint8Array);
    expect(enc.length).toBeGreaterThanOrEqual(12 + 16);
    const dec = await decryptLicense(enc);
    expect(dec).toEqual(EMPTY_LICENSE);
  });

  test('roundtrips a populated PRO license', async () => {
    const lic: License = {
      key: 'PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD',
      status: 'valid',
      tier: 'pro',
      expiresAt: null,
      lastValidated: 1700000000000,
      trialStartedAt: null,
    };
    const enc = await encryptLicense(lic);
    const dec = await decryptLicense(enc);
    expect(dec).toEqual(lic);
  });

  test('rejects a tampered blob (GCM tag check)', async () => {
    const lic: License = {
      key: 'PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD',
      status: 'valid',
      tier: 'pro',
      expiresAt: null,
      lastValidated: 1700000000000,
      trialStartedAt: null,
    };
    const enc = await encryptLicense(lic);
    // Flip a bit in the middle (after the IV).
    enc[15] ^= 0xff;
    await expect(decryptLicense(enc)).rejects.toThrow();
  });

  test('rejects a too-short blob', async () => {
    const tiny = new Uint8Array(10);
    await expect(decryptLicense(tiny)).rejects.toThrow(/too short/);
  });
});
