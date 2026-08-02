// SPDX-License-Identifier: Apache-2.0
// Pulse — PRO settings section (R119 PRO foundation).
//
// Shown inside the SettingsView. Two states:
//   * Free    → paste-key input + "Get PRO" CTA.
//   * PRO     → license summary + "Sign out" button.

import { useEffect, useState } from 'react';
import { LicenseInput } from '../PRO/LicenseInput';
import { PROBadge } from '../PRO/PROBadge';
import { licenseStore } from '../../lib/license/store';
import type { License } from '../../lib/license/types';

const PRO_URL = 'https://buy.polar.sh/pulse-monthly';

export function PROSettings() {
  const [license, setLicense] = useState<License>(() => licenseStore.current());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    return licenseStore.subscribe(setLicense);
  }, []);

  async function handleActivate(key: string) {
    setError(null);
    setBusy(true);
    try {
      await licenseStore.setKey(key);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function handleDeactivate() {
    setError(null);
    setBusy(true);
    try {
      await licenseStore.clear();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function openCheckout() {
    if (typeof window !== 'undefined') {
      window.open(PRO_URL, '_blank', 'noopener,noreferrer');
    }
  }

  if (license.tier === 'pro') {
    return (
      <div className="pro-settings" data-tier="pro">
        <div className="pro-settings__head">
          <span className="pro-settings__title">PRO license</span>
          <PROBadge active />
        </div>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Status</span>
          <span className="pro-settings__value">{license.status}</span>
        </div>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Key</span>
          <code className="pro-settings__value pro-settings__key">{license.key}</code>
        </div>
        {license.expiresAt !== null && (
          <div className="pro-settings__row">
            <span className="pro-settings__label">Expires</span>
            <span className="pro-settings__value">
              {new Date(license.expiresAt).toISOString().slice(0, 10)}
            </span>
          </div>
        )}
        {error && <div className="pro-settings__error">{error}</div>}
        <div className="pro-settings__actions">
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--ghost"
            onClick={handleDeactivate}
            disabled={busy}
          >
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pro-settings" data-tier="free">
      <div className="pro-settings__head">
        <span className="pro-settings__title">PRO license</span>
        <span className="pro-settings__pill">Free</span>
      </div>
      <p className="pro-settings__hint">
        Activate a PRO key to unlock multi-model hot-swap, code intelligence,
        Whisper voice input, and web search inside the panel.
      </p>
      <div className="pro-settings__row">
        <span className="pro-settings__label">Key</span>
        <LicenseInput
          onSubmit={handleActivate}
          disabled={busy}
          externalError={error}
        />
      </div>
      <div className="pro-settings__actions">
        <button
          type="button"
          className="pro-settings__btn pro-settings__btn--primary"
          onClick={openCheckout}
        >
          Get PRO
        </button>
      </div>
    </div>
  );
}
