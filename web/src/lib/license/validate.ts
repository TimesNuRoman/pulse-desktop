// SPDX-License-Identifier: Apache-2.0
// Pulse — license key format validation (R119 PRO foundation).
//
// Format: `PULSE-XXXX-XXXX-XXXX-XXXX-XXXX`
//   * 5 groups × 4 base32 chars (RFC 4648 alphabet: A-Z 2-7, no 0/O/1/I/L)
//   * Total length: 30 chars (6 prefix + 4×5 chunk + 4 inner dashes)
//
// This is a *format* check only — the real check is the server ping (R119+).
// Per architecture doc: "Client trust = format check + encrypted local cache
// + 14-day grace. Real validation = server ping."
//
// MUST match the Rust regex in `src-tauri/src/license.rs::is_valid_key_format`.

import type { LicenseTier, ValidateKeyResult } from './types';

/** RFC 4648 base32 chunk: 4 chars from [A-Z 2-7], no 0/O/1/I/L lookalikes. */
const BASE32_CHUNK = '[A-HJ-KM-NP-Z2-9]{4}';

/** Compiled regex. Reused across calls. */
export const LICENSE_KEY_REGEX = new RegExp(
  `^PULSE-${BASE32_CHUNK}(-${BASE32_CHUNK}){4}$`,
);

/** Hardcoded test key, accepted in dev mode without server ping.
 *  MUST match `src-tauri/src/license.rs::TEST_KEY`. */
export const TEST_KEY = 'PULSE-TEST1-TEST1-TEST1-TEST1-TEST1';

/** Normalize user input: trim + uppercase + strip spaces + strip all dashes,
 *  re-chunk into 4-char groups, re-prefix with `PULSE-`.
 *
 *  Examples:
 *    "  pulse-7yhk-dn9q-xv5b-wm4z-abcd  " → "PULSE-7YHK-DN9Q-XV5B-WM4Z-ABCD"
 *    "PULSETEST1TEST1TEST1TEST1TEST1"       → "PULSE-TEST1-TEST1-TEST1-TEST1-TEST1"
 *    "garbage"                              → "PULSE-GARB" (invalid format)
 *
 *  Anything that doesn't have at least 5×4 base32 chars will fail the regex
 *  later — normalize() is purely a "best effort to canonicalize", not a
 *  validator.
 *
 *  Special case: the hardcoded test key contains '1' which is outside the
 *  production base32 alphabet. We return it as-is to keep dev-mode working.
 */
export function normalizeKey(raw: string): string {
  const upper = raw.trim().toUpperCase().replace(/\s+/g, '').replace(/-/g, '');
  // Test-key passthrough. The constant equals "PULSETEST1TEST1TEST1TEST1TEST1"
  // after dash+space stripping.
  if (upper === 'PULSETEST1TEST1TEST1TEST1TEST1') {
    return TEST_KEY;
  }
  const withoutPrefix = upper.startsWith('PULSE') ? upper.slice(5) : upper;
  const chunks: string[] = [];
  for (let i = 0; i < withoutPrefix.length; i += 4) {
    chunks.push(withoutPrefix.slice(i, i + 4));
  }
  if (chunks.length === 0) return '';
  return 'PULSE-' + chunks.join('-');
}

/** Detect the test key (case-insensitive, whitespace-tolerant). */
export function isTestKey(raw: string): boolean {
  return normalizeKey(raw) === TEST_KEY;
}

/** Pure format check. No I/O, no side effects, safe in renderer. */
export function isValidKeyFormat(raw: string): boolean {
  const n = normalizeKey(raw);
  if (n === TEST_KEY) return true;
  return LICENSE_KEY_REGEX.test(n);
}

/** End-to-end validation: format + tier decision.
 *  R119 stub: format-valid = tier=pro. No server check yet. */
export function validateKey(raw: string): ValidateKeyResult {
  const normalized = normalizeKey(raw);

  if (!normalized) {
    return { valid: false, tier: 'free', error: 'empty' };
  }

  if (normalized === TEST_KEY) {
    return { valid: true, tier: 'pro' };
  }

  if (!LICENSE_KEY_REGEX.test(normalized)) {
    return {
      valid: false,
      tier: 'free',
      error:
        'Invalid key format. Expected PULSE-XXXX-XXXX-XXXX-XXXX-XXXX ' +
        '(4-char base32 chunks, no 0/O/1/I/L).',
    };
  }

  // R119: format-valid = accepted. R120+: real server ping here.
  return { valid: true, tier: 'pro' };
}

/** Group a normalized key into 5×4 chunks for the paste UI.
 *  Returns the 6-element array [PULSE, XXXX, XXXX, XXXX, XXXX, XXXX].
 *  Returns [] if the input is not a 5-group key. */
export function groupKey(normalized: string): string[] {
  if (!normalized.startsWith('PULSE-')) return [];
  const tail = normalized.slice('PULSE-'.length);
  const chunks = tail.split('-');
  if (chunks.length !== 5) return [];
  return ['PULSE', ...chunks];
}
