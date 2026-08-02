// SPDX-License-Identifier: Apache-2.0
// Tests for license key format validation (R119 PRO foundation).
//
// Pure logic. No DOM, no Tauri. Run via `npm test`.

import { describe, test, expect } from 'vitest';
import {
  validateKey,
  isValidKeyFormat,
  isTestKey,
  normalizeKey,
  groupKey,
  TEST_KEY,
} from '../validate';

describe('validateKey — format', () => {
  // Canonical 5-group production key (30 chars total, each group 4 chars).
  const KEY = 'PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD';

  test('accepts well-formed production key', () => {
    const r = validateKey(KEY);
    expect(r.valid).toBe(true);
    expect(r.tier).toBe('pro');
    expect(r.error).toBeUndefined();
  });

  test('accepts hardcoded test key', () => {
    const r = validateKey(TEST_KEY);
    expect(r.valid).toBe(true);
    expect(r.tier).toBe('pro');
  });

  test('rejects empty input', () => {
    const r = validateKey('');
    expect(r.valid).toBe(false);
    expect(r.tier).toBe('free');
    expect(r.error).toBe('empty');
  });

  test('rejects bad format — too few chunks (4 groups)', () => {
    const r = validateKey('PULSE-2345-6789-ABCD-EFGH');
    expect(r.valid).toBe(false);
    expect(r.tier).toBe('free');
    expect(r.error).toMatch(/Invalid key format/);
  });

  test('rejects bad format — too many chunks (6 groups)', () => {
    const r = validateKey('PULSE-2345-6789-ABCD-EFGH-JKMN-XXXX');
    expect(r.valid).toBe(false);
  });

  test('rejects bad format — excluded characters (0, O, I, L, 1)', () => {
    // 0, O, I, L, 1 are not in the base32 alphabet
    const r = validateKey('PULSE-0ABC-DEFG-HIJK-LMNO-PQRS');
    expect(r.valid).toBe(false);
    expect(r.tier).toBe('free');
  });

  test('rejects bad format — wrong prefix', () => {
    const r = validateKey('XPULS-7YHK-DN9Q-XV5B-WM4Z-ABCD');
    expect(r.valid).toBe(false);
  });

  test('rejects completely garbage', () => {
    const r = validateKey('garbage');
    expect(r.valid).toBe(false);
  });

  test('normalizes whitespace + case + dashes', () => {
    expect(normalizeKey('  pulse-7yhk-dn9q-xv5b-wm4z-abcd  ')).toBe(KEY);
  });

  test('groupKey returns 6 chunks for valid key', () => {
    expect(groupKey(KEY)).toEqual([
      'PULSE',
      '7YHK',
      'DN9Q',
      'XV5B',
      'WM4Z',
      'ABCD',
    ]);
  });

  test('isValidKeyFormat mirrors validateKey for happy path', () => {
    expect(isValidKeyFormat(KEY)).toBe(true);
    expect(isValidKeyFormat('PULSE-2345-6789-ABCD-EFGH-JKMN')).toBe(true);
    expect(isValidKeyFormat('garbage')).toBe(false);
  });

  test('isTestKey is case- and whitespace-insensitive', () => {
    expect(isTestKey(TEST_KEY)).toBe(true);
    expect(isTestKey('  pulse-test1-test1-test1-test1-test1  ')).toBe(true);
    expect(isTestKey('PULSE-2345-6789-ABCD-EFGH-JKMN')).toBe(false);
  });
});
