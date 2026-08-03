// SPDX-License-Identifier: Apache-2.0
// Pulse — trial helper tests (R191 14-day trial).
//
// Pure logic, no DOM, no Tauri. Covers:
//   * getTrialDaysRemaining (fresh, mid, expired, no-trial)
//   * formatTrialCountdown (13/1/0/-1)
//   * EMPTY_LICENSE shape (status='none', trialStartedAt=null)
//   * TRIAL_DURATION_MS equals 14 days
//
// The store-level trial behaviour (auto-start on load, startTrial
// idempotency, applyGrace expiry) lives in store.test.ts.

import { describe, test, expect } from 'vitest';
import {
  EMPTY_LICENSE,
  TRIAL_DURATION_MS,
  type License,
} from '../types';
import { getTrialDaysRemaining, formatTrialCountdown } from '../validate';

function trialLicense(trialStartedAt: number | null): License {
  return {
    key: '',
    status: 'trial',
    tier: 'pro',
    expiresAt: null,
    lastValidated: 0,
    trialStartedAt,
  };
}

function dayMs(n: number): number {
  return n * 24 * 60 * 60 * 1000;
}

describe('TRIAL_DURATION_MS', () => {
  test('equals 14 days in milliseconds', () => {
    expect(TRIAL_DURATION_MS).toBe(14 * 24 * 60 * 60 * 1000);
    expect(TRIAL_DURATION_MS).toBe(dayMs(14));
  });
});

describe('EMPTY_LICENSE (R191 shape)', () => {
  test('has status="none"', () => {
    expect(EMPTY_LICENSE.status).toBe('none');
  });
  test('has trialStartedAt=null', () => {
    expect(EMPTY_LICENSE.trialStartedAt).toBeNull();
  });
  test('tier is "pro" so trial auto-start lands in PRO state', () => {
    expect(EMPTY_LICENSE.tier).toBe('pro');
  });
  test('key is empty', () => {
    expect(EMPTY_LICENSE.key).toBe('');
  });
});

describe('getTrialDaysRemaining', () => {
  test('fresh trial (just started) → 14 days', () => {
    const now = 1_000_000_000_000;
    const l = trialLicense(now);
    expect(getTrialDaysRemaining(l, now)).toBe(14);
  });

  test('mid-trial (7 days in) → 7 days remaining', () => {
    const start = 1_000_000_000_000;
    const now = start + dayMs(7);
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(7);
  });

  test('1 day in → 13 days remaining', () => {
    const start = 1_000_000_000_000;
    const now = start + dayMs(1);
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(13);
  });

  test('elapsed exactly at boundary → 0 (expired)', () => {
    const start = 1_000_000_000_000;
    const now = start + TRIAL_DURATION_MS;
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(0);
  });

  test('elapsed past boundary → 0 (expired)', () => {
    const start = 1_000_000_000_000;
    const now = start + dayMs(20);
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(0);
  });

  test('no trial started (trialStartedAt=null) → -1 sentinel', () => {
    const l = trialLicense(null);
    expect(getTrialDaysRemaining(l)).toBe(-1);
  });

  test('partial day (12h elapsed) still rounds UP to 14', () => {
    const start = 1_000_000_000_000;
    const now = start + 12 * 60 * 60 * 1000;
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(14);
  });

  test('13 days + 23h elapsed → 1 day remaining (rounded up to next boundary)', () => {
    const start = 1_000_000_000_000;
    const now = start + dayMs(13) + 23 * 60 * 60 * 1000;
    const l = trialLicense(start);
    expect(getTrialDaysRemaining(l, now)).toBe(1);
  });
});

describe('formatTrialCountdown', () => {
  test('13 days → "13 days left"', () => {
    expect(formatTrialCountdown(13)).toBe('13 days left');
  });
  test('1 day → "1 day left" (singular)', () => {
    expect(formatTrialCountdown(1)).toBe('1 day left');
  });
  test('0 days → "Trial expired"', () => {
    expect(formatTrialCountdown(0)).toBe('Trial expired');
  });
  test('negative → "Trial not started" (defensive fallback)', () => {
    expect(formatTrialCountdown(-1)).toBe('Trial not started');
  });
  test('14 days → "14 days left"', () => {
    expect(formatTrialCountdown(14)).toBe('14 days left');
  });
  test('2 days → "2 days left" (plural)', () => {
    expect(formatTrialCountdown(2)).toBe('2 days left');
  });
});
