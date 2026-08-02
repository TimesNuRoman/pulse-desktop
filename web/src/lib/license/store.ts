// SPDX-License-Identifier: Apache-2.0
// Pulse — license store (R119 PRO foundation).
//
// Framework-agnostic observable store (subscribe / get). Works in React via
// `useSyncExternalStore`, in Svelte via onMount subscription, and in vanilla
// test code via direct subscribe. Mirrors the Svelte writable-store contract
// (load/setKey/clear/current) but emits events through a Set of listeners.
//
// Lifecycle:
//   1. On cold start, call `await store.load()`. It reads the encrypted
//      blob from Rust (license_read), decrypts, and hydrates the state.
//   2. After activation, call `await store.setKey(key)`. It validates,
//      encrypts, writes (license_write), and updates state.
//   3. To deactivate, call `await store.clear()`. It removes the file
//      (license_clear) and resets to EMPTY_LICENSE.
//
// This module is the single source of truth for "is the user PRO?". Every
// gate (`requirePro`) reads from here.

import { invoke } from '@tauri-apps/api/core';
import {
  EMPTY_LICENSE,
  ProRequiredError,
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
    return () => this.listeners.delete(listener);
  };

  private setState(next: License) {
    this.state = next;
    for (const l of this.listeners) l(next);
  }

  /** Synchronous current state. */
  current(): License {
    return this.state;
  }

  /** Is the current state PRO? Accounts for grace period. */
  isPro(): boolean {
    const s = this.state;
    if (s.tier === 'free') return false;
    if (s.expiresAt !== null && s.expiresAt < Date.now()) return false;
    return true;
  }

  /** Throw ProRequiredError if not PRO. Use in async action paths. */
  requirePro(feature: ProFeature): void {
    if (!this.isPro()) {
      throw new ProRequiredError(feature);
    }
  }

  /** Cold-start hydration. Safe to call multiple times — caches promise. */
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
    try {
      const bytes: number[] | null = await invoke<number[] | null>(
        'license_read',
      );
      if (!bytes || bytes.length === 0) {
        this.setState(EMPTY_LICENSE);
        return this.state;
      }
      const u8 = new Uint8Array(bytes);
      const license = await decryptLicense(u8);
      this.setState(this.applyGrace(license));
      return this.state;
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
      this.setState(EMPTY_LICENSE);
      return this.state;
    }
  }

  /** Validate a key, encrypt, write to disk, update state. */
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
    };
    if (inTauri()) {
      const enc = await encryptLicense(license);
      // Tauri's invoke serializes Uint8Array as number[].
      await invoke('license_write', { bytes: Array.from(enc) });
    }
    this.setState(license);
    return this.state;
  }

  /** Remove the on-disk license and reset to free. */
  async clear(): Promise<void> {
    if (inTauri()) {
      try {
        await invoke('license_clear');
      } catch {
        /* ignore */
      }
    }
    this.setState(EMPTY_LICENSE);
  }

  /** Decide offline-grace status based on `lastValidated` age. */
  private applyGrace(license: License): License {
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
