// SPDX-License-Identifier: Apache-2.0
// Pulse — license types (R119 PRO foundation).
//
// Single source of truth for license shape. Shared between web/src (UI,
// gating, validation) and src-tauri (license.bin read/write).
//
// Architectural decisions (PULSE-PRO-ARCHITECTURE-2026-08-02.md):
//   * `key` is an opaque bearer token. No client crypto proof.
//   * `tier` = 'free' | 'pro'. Free = no key, or invalid. Pro = valid key.
//   * `status` is a state-machine value used by the UI:
//       'none'             → no license on disk, free tier
//       'valid'            → valid key, ping OK (or just-activated)
//       'expired'          → key format valid but exp < now
//       'offline-grace'    → key valid + cached, but ping > 14d old
//   * `expiresAt` = unix-ms timestamp. `null` = lifetime / test key.
//   * `lastValidated` = unix-ms of last successful validate/ping. Used for
//     grace-period calculation.

/** A PRO feature. The same set lives in `web/src/lib/pro-features.ts` for
 *  catalog/free-fallback info. The enum here is the type-side contract. */
export type ProFeature =
  | 'multi-model'        // hot-swap between multiple LLM models
  | 'code-intel'         // tree-sitter symbol extraction / cross-file refs
  | 'voice-input'        // Whisper STT (vs OS SpeechRecognition which is free)
  | 'web-search'         // Habr / YouTube search inside panel
  | 'settings-sync'      // (R120) cloud sync of settings
  | 'priority-updates';  // (R120) early-access release channel

/** License tier. Kept narrow on purpose: anything new = new round + migration. */
export type LicenseTier = 'free' | 'pro';

/** License state for UI. Drives badge color, modal triggers, grace banners. */
export type LicenseStatus =
  | 'none'            // no license on disk → free
  | 'valid'           // ping OK (or never pinged, freshly activated)
  | 'expired'         // key format valid but exp < now
  | 'offline-grace';  // cached OK but server ping > 14d ago

/** Persistent license record (what we encrypt to disk). */
export interface License {
  /** The raw key, e.g. "PULSE-7YHK2-DN9Q8-XV5B3-WM4ZT". Empty for free tier. */
  key: string;
  /** Current tier. */
  status: LicenseStatus;
  /** 'free' if no key / expired; 'pro' if valid. */
  tier: LicenseTier;
  /** Unix-ms expiration timestamp. `null` = lifetime / no expiry. */
  expiresAt: number | null;
  /** Unix-ms when validate/ping last succeeded. Used for grace math. */
  lastValidated: number;
}

/** Empty / free license. Default before any activation. */
export const EMPTY_LICENSE: License = {
  key: '',
  status: 'none',
  tier: 'free',
  expiresAt: null,
  lastValidated: 0,
};

/** Sentinel error type for `requirePro(feature)`. UI catches this and shows
 *  the upgrade modal. Never thrown for non-PRO paths. */
export class ProRequiredError extends Error {
  readonly feature: ProFeature;
  constructor(feature: ProFeature, message?: string) {
    super(message ?? `PRO license required for feature: ${feature}`);
    this.name = 'ProRequiredError';
    this.feature = feature;
  }
}

/** Result of format validation. Returned synchronously, no I/O. */
export interface ValidateKeyResult {
  valid: boolean;
  tier: LicenseTier;
  /** Machine-readable reason, only set when `valid === false`. */
  error?: string;
}

/** Result of license_ping Tauri command (server stub for R119). */
export interface LicensePingResult {
  valid: boolean;
  tier: LicenseTier;
  /** Unix-ms exp returned by server. `null` if server didn't return one. */
  expiresAt: number | null;
  /** Optional human-readable note for UI (e.g. "server unreachable"). */
  message?: string;
}
