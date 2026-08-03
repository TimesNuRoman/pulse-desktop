// SPDX-License-Identifier: Apache-2.0
// Pulse — license store (R119 PRO foundation, R191 trial).
//
// Framework-agnostic observable store (subscribe / get). Works in React via
// `useSyncExternalStore`, in Svelte via onMount subscription, and in vanilla
// test code via direct subscribe. Mirrors the Svelte writable-store contract
// (load/setKey/clear/current) but emits events through a Set of listeners.
//
// Lifecycle (R191):
//   1. On cold start, call `await store.load()`. It reads the encrypted
//      blob from Rust (license_read), decrypts, hydrates the state, and
//      auto-starts the 14-day trial for first-time installs.
//   2. After activation, call `await store.setKey(key)`. It validates,
//      encrypts, writes (license_write), and updates state. The
//      `trialStartedAt` is preserved so "Day X of trial, then upgraded"
//      still reads correctly in audit logs / future R192+ reporting.
//   3. To deactivate, call `await store.clear()`. It removes the file
//      (license_clear) and resets to EMPTY_LICENSE. Next `load()` will
//      start a fresh trial (R191 product decision: deactivate-then-relaunch
//      grants a new 14-day window).
//
// This module is the single source of truth for "is the user PRO?". Every
// gate (`requirePro`) reads from here.

import { invoke } from '@tauri-apps/api/core';
import {
  EMPTY_LICENSE,
  ProRequiredError,
  TRIAL_DURATION_MS,
  type License,
  type ProFeature,
} from './types';
import { validateKey } from './validate';
import { encryptLicense, decryptLicense } from './crypto';

/** Check at call time so tests can flip the global between cases. */
function inTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    (Boolean((window as any).__TAURI_INTERNALS__) ||
      Boolean((window as any).__TAURI__))
  );
}

/** Grace period (ms) for offline use after last successful ping. */
export const GRACE_PERIOD_MS = 14 * 24 * 60 * 60 * 1000;

type Listener = (license: License) => void;

class LicenseStore {
  private state: License = EMPTY_LICENSE;
  private listeners: Set<Listener> = new Set();
  private loadPromise: Promise<License> | null = null;

  /** Read-only accessor (Snapshot API for React useSyncExternalStore). */
  getSnapshot = (): License => this.state;

  /** Subscribe to state changes. Returns unsubscribe. */
  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  private setState(next: License) {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  /** Synchronous current state. */
  current(): License {
    return this.state;
  }

  /** Is the current state PRO? Accounts for trial + grace period.
   *
   *  R191 rule: PRO = (valid key + not expired + within grace) OR
   *  (trial started + not yet elapsed). Trial is "PRO with an expiry
   *  check" — same gates, different status. The `tier === 'pro'`
   *  short-circuit covers the common case (setKey, fresh trial) so
   *  we don't pay for two `Date.now()` reads in the hot path. */
  isPro(): boolean {
    const s = this.state;
    if (s.tier !== 'pro') return false;
    if (s.status === 'valid') return true;
    if (s.status === 'offline-grace') return true; // grace = "still PRO"
    if (s.status === 'trial') {
      if (s.trialStartedAt === null) return false;
      return Date.now() - s.trialStartedAt < TRIAL_DURATION_MS;
    }
    // 'expired' or 'none' → not PRO.
    return false;
  }

  /** Throw ProRequiredError if not PRO. Use in async action paths. */
  requirePro(feature: ProFeature): void {
    if (!this.isPro()) {
      throw new ProRequiredError(feature);
    }
  }

  /** Cold-start hydration. Safe to call multiple times — caches promise.
   *  R191: if no license is on disk OR the disk has the legacy
   *  `status='none'` shape with no `trialStartedAt`, auto-start the
   *  14-day trial. */
  async load(): Promise<License> {
    if (this.loadPromise) return this.loadPromise;
    this.loadPromise = this.doLoad();
    return this.loadPromise;
  }

  private async doLoad(): Promise<License> {
    if (!inTauri()) {
      // Web/Capacitor: no disk. Free tier.
      this.setState(EMPTY_LICENSE);
      return this.state;
    }
    let license: License | null = null;
    try {
      const bytes: number[] | null = await invoke<number[] | null>(
        'license_read',
      );
      if (bytes && bytes.length > 0) {
        const u8 = new Uint8Array(bytes);
        license = await decryptLicense(u8);
      }
    } catch (e) {
      // Tampered or corrupt — treat as free, drop the blob.
      // We do NOT re-throw: a bad license file shouldn't block the app.
      // eslint-disable-next-line no-console
      console.warn('license_read: failed to decrypt, falling back to free:', e);
      try {
        await invoke('license_clear');
      } catch {
        /* ignore */
      }
      license = null;
    }

    // R191: if there's no usable license on disk, auto-start the trial.
    // This is the critical flow — first launch starts the trial so the
    // user gets a 14-day PRO window without any activation.
    if (!license || (license.status === 'none' && license.trialStartedAt === null)) {
      const started = await this.startTrial();
      return started;
    }

    // Migration: legacy install where status='none' but trialStartedAt
    // is set means a previous session started a trial and then the disk
    // was wiped. Treat that as "expired trial" (don't restart the clock).
    if (license.status === 'none' && license.trialStartedAt !== null) {
      this.setState(this.applyGrace({
        ...license,
        status: 'expired',
        tier: 'pro',
      }));
      return this.state;
    }

    this.setState(this.applyGrace(license));
    return this.state;
  }

  /** Start (or no-op resume) the 14-day PRO trial.
   *
   *  Idempotent: never overwrites an existing trial's `trialStartedAt`,
   *  and never overwrites a paid PRO license. Returns the current
   *  license state. The trial is persisted to disk via `license_write`
   *  when running in Tauri, so the 14-day window survives restarts. */
  async startTrial(): Promise<License> {
    const s = this.state;
    // Already in an active trial — leave the clock alone.
    if (s.status === 'trial' && s.trialStartedAt !== null) {
      return s;
    }
    // Already on a paid PRO license — never overwrite.
    if (s.status === 'valid' || s.status === 'offline-grace') {
      return s;
    }
    const now = Date.now();
    const license: License = {
      key: '',
      status: 'trial',
      tier: 'pro',
      expiresAt: null,
      lastValidated: 0,
      trialStartedAt: now,
    };
    if (inTauri()) {
      try {
        const enc = await encryptLicense(license);
        await invoke('license_write', { bytes: Array.from(enc) });
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn('startTrial: license_write failed, in-memory only:', e);
      }
    }
    this.setState(license);
    return this.state;
  }

  /** Validate a key, encrypt, write to disk, update state.
   *  R191: `trialStartedAt` is preserved on upgrade so the audit
   *  trail ("user trialled for N days, then upgraded") survives. */
  async setKey(rawKey: string): Promise<License> {
    const v = validateKey(rawKey);
    if (!v.valid || v.tier === 'free') {
      // Surface the same shape as ValidateKeyResult, but as an Error
      // for ergonomic try/catch at call sites.
      throw new Error(v.error ?? 'Invalid license key');
    }
    const now = Date.now();
    // R119 stub: no real server ping. expiresAt = null (lifetime-like).
    // R120+ will replace this with the actual server response.
    const license: License = {
      key: rawKey.trim().toUpperCase(),
      status: 'valid',
      tier: 'pro',
      expiresAt: null,
      lastValidated: now,
      // Preserve the trial anchor if the user upgraded mid-trial.
      // `null` for users who never started a trial (paid-first).
      trialStartedAt: this.state.trialStartedAt,
    };
    if (inTauri()) {
      const enc = await encryptLicense(license);
      // Tauri's invoke serializes Uint8Array as number[].
      await invoke('license_write', { bytes: Array.from(enc) });
    }
    this.setState(license);
    return this.state;
  }

  /** Remove the on-disk license and reset to free.
   *  R191: next `load()` will auto-start a fresh trial. The cached
   *  `loadPromise` is also reset so a subsequent `load()` re-reads
   *  the (now-empty) disk and re-runs the auto-start flow — without
   *  this, tests and production alike would see a stale "first load"
   *  result and never re-trigger the trial on a wipe. */
  async clear(): Promise<void> {
    if (inTauri()) {
      try {
        await invoke('license_clear');
      } catch {
        /* ignore */
      }
    }
    this.loadPromise = null;
    this.setState(EMPTY_LICENSE);
  }

  /** Decide offline-grace / trial-expiry status based on timestamps.
   *  R191: a `status === 'trial'` record whose `trialStartedAt` is older
   *  than `TRIAL_DURATION_MS` transitions to `status === 'expired'`. The
   *  `tier` stays `'pro'` so `isPro()` falls through to the explicit
   *  status check (returns false). */
  private applyGrace(license: License): License {
    if (license.status === 'trial' && license.trialStartedAt !== null) {
      if (Date.now() - license.trialStartedAt >= TRIAL_DURATION_MS) {
        return { ...license, status: 'expired' };
      }
      return license;
    }
    if (license.tier === 'free') return license;
    if (license.expiresAt !== null && license.expiresAt < Date.now()) {
      return { ...license, status: 'expired', tier: 'free' };
    }
    const age = Date.now() - license.lastValidated;
    if (age > GRACE_PERIOD_MS) {
      return { ...license, status: 'offline-grace' };
    }
    return license;
  }
}

/** Singleton store. Import this everywhere; do not construct. */
export const licenseStore = new LicenseStore();
