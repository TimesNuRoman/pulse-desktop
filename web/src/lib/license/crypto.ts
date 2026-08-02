// SPDX-License-Identifier: Apache-2.0
// Pulse — license payload encryption (R119 PRO foundation).
//
// AES-GCM 256 via WebCrypto. Used to wrap `license.bin` BEFORE the JS side
// hands the bytes to Rust (which writes them to disk as raw bytes).
//
// On-disk format: `[12-byte IV][N-byte ciphertext][16-byte GCM tag]`.
// GCM tag validation on read = tamper detection (per architecture §4).
//
// KEK derivation: SHA-256(APP_SECRET || deviceSalt). APP_SECRET is a build-
// time constant embedded in the JS bundle; deviceSalt is generated on first
// run and stored separately. This is *tamper resistance*, not tamper
// prevention — per the threat model in the architecture doc, "open the JSON
// in Notepad" is the attack we deter, not a determined RE.

import type { License } from './types';

const APP_SECRET = 'pulse-r119-pro-foundation-license-v1';
const SALT_STORAGE_KEY = 'pulse.license.device_salt.v1';

/** Get or create a per-device salt. Stored in localStorage. */
async function getDeviceSalt(): Promise<string> {
  if (typeof localStorage === 'undefined') {
    // SSR / test env without DOM: use a fixed fallback.
    return 'pulse-test-salt';
  }
  try {
    const existing = localStorage.getItem(SALT_STORAGE_KEY);
    if (existing) return existing;
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    const salt = Array.from(bytes)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    localStorage.setItem(SALT_STORAGE_KEY, salt);
    return salt;
  } catch {
    // localStorage might be disabled (private mode, etc.).
    return 'pulse-fallback-salt';
  }
}

/** Derive a 256-bit KEK from APP_SECRET + deviceSalt. */
async function deriveKek(): Promise<CryptoKey> {
  const salt = await getDeviceSalt();
  const enc = new TextEncoder();
  const seed = await crypto.subtle.digest(
    'SHA-256',
    enc.encode(`${APP_SECRET}|${salt}`),
  );
  return crypto.subtle.importKey(
    'raw',
    seed,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Encrypt a License to the on-disk bytes format.
 *  Returns a Uint8Array = IV(12) || ciphertext || tag(16). */
export async function encryptLicense(license: License): Promise<Uint8Array> {
  const key = await deriveKek();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(license));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext),
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv, 0);
  out.set(ct, iv.length);
  return out;
}

/** Decrypt on-disk bytes to a License. Throws if tag validation fails
 *  (= tampered or wrong key). */
export async function decryptLicense(bytes: Uint8Array): Promise<License> {
  if (bytes.length < 12 + 16) {
    throw new Error('license blob too short');
  }
  const iv = bytes.slice(0, 12);
  const ct = bytes.slice(12);
  const key = await deriveKek();
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
  const json = new TextDecoder().decode(pt);
  const parsed = JSON.parse(json) as License;
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof parsed.key !== 'string' ||
    typeof parsed.tier !== 'string'
  ) {
    throw new Error('license payload malformed');
  }
  return parsed;
}
