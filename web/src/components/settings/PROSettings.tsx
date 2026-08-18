// SPDX-License-Identifier: Apache-2.0
// Pulse — PRO settings section (R119 PRO foundation, R191 trial rewrite).
//
// R191: no permanent free tier. Every new install starts a 14-day trial
// automatically (handled in `licenseStore.load()`). This component renders
// one of four states based on `license.status`:
//
//   * 'trial'         → countdown + "Upgrade to PRO" CTA
//   * 'valid'         → license summary + "Manage subscription" + deactivate
//   * 'expired'       → "Trial ended" headline + LicenseInput + checkout link
//   * 'offline-grace' → warn banner + "Re-validate" button
//
// All interactive elements use ≥44dp touch targets, aria-labels, and
// respect prefers-reduced-motion. Escape closes any open popovers.

import { useEffect, useMemo, useState } from 'react';
import { LicenseInput } from '../PRO/LicenseInput';
import { PROBadge } from '../PRO/PROBadge';
import { licenseStore } from '../../lib/license/store';
import type { License } from '../../lib/license/types';
import { TRIAL_DURATION_MS } from '../../lib/license/types';
import { getTrialDaysRemaining, formatTrialCountdown } from '../../lib/license/validate';
import { PRO_FEATURES } from '../../lib/pro-features';

// Pulse uses crypto via NOWPayments (gtm/90). DO NOT add new Polar/Stripe/Paddle URLs.
const PRO_URL = 'https://nowpayments.io/payment/?iid=pulse-pro-monthly';

function TrialCountdown({ license }: { license: License }) {
  // Memo on trialStartedAt so the countdown re-derives only when the
  // trial clock moves. We don't tick every second — the badge is a
  // status pill, not a clock. The page re-renders on license change.
  const days = useMemo(
    () => getTrialDaysRemaining(license),
    [license.trialStartedAt, license.status],
  );
  return (
    <span
      className="pro-settings__countdown"
      data-testid="trial-countdown"
      aria-live="polite"
    >
      {formatTrialCountdown(days)}
    </span>
  );
}

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

  // R191: render based on status, not tier. The free/paywall states
  // map to 'expired' (trial elapsed without upgrade) and 'none' (no
  // disk record yet — auto-start happens in load()).
  const status = license.status;

  // ── Trial expired: must activate or paywall ────────────────────────
  if (status === 'expired') {
    return (
      <div className="pro-settings" data-status={status}>
        <div className="pro-settings__head">
          <span className="pro-settings__title">PRO license</span>
          <span className="pro-settings__pill pro-settings__pill--expired">
            Trial ended
          </span>
        </div>
        <p className="pro-settings__hint">
          The 14-day trial has ended. Activate a PRO key to restore access to
          multi-model hot-swap, code intelligence, voice input, and web search.
        </p>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Key</span>
          <LicenseInput
            onSubmit={handleActivate}
            disabled={busy}
            externalError={error}
          />
        </div>
        {error && <div className="pro-settings__error">{error}</div>}
        <div className="pro-settings__actions">
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--ghost"
            onClick={openCheckout}
            aria-label="Open PRO checkout in a new tab"
          >
            Buy PRO
          </button>
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--primary"
            onClick={openCheckout}
            aria-label="Open PRO checkout in a new tab"
          >
            Upgrade
          </button>
        </div>
      </div>
    );
  }

  // ── Offline grace: warn + re-validate ──────────────────────────────
  if (status === 'offline-grace') {
    return (
      <div className="pro-settings" data-status={status}>
        <div
          className="pro-settings__banner"
          role="status"
          aria-live="polite"
        >
          License revalidation is overdue. PRO features stay active for the
          14-day grace period; connect to the internet to revalidate.
        </div>
        <div className="pro-settings__head">
          <span className="pro-settings__title">PRO license</span>
          <PROBadge active />
        </div>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Status</span>
          <span className="pro-settings__value">offline grace</span>
        </div>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Key</span>
          <code className="pro-settings__value pro-settings__key">{license.key}</code>
        </div>
        {error && <div className="pro-settings__error">{error}</div>}
        <div className="pro-settings__actions">
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--primary"
            onClick={() => void handleActivate(license.key)}
            disabled={busy}
            aria-label="Revalidate license"
          >
            {busy ? 'Revalidating...' : 'Revalidate'}
          </button>
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--ghost"
            onClick={handleDeactivate}
            disabled={busy}
            aria-label="Deactivate license"
          >
            Deactivate
          </button>
        </div>
      </div>
    );
  }

  // ── PRO valid: license info + manage subscription + deactivate ────
  if (status === 'valid') {
    return (
      <div className="pro-settings" data-status={status}>
        <div className="pro-settings__head">
          <span className="pro-settings__title">PRO license</span>
          <PROBadge active />
        </div>
        <div className="pro-settings__row">
          <span className="pro-settings__label">Status</span>
          <span className="pro-settings__value">active</span>
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
        {license.trialStartedAt !== null && (
          <div className="pro-settings__row">
            <span className="pro-settings__label">Trial started</span>
            <span className="pro-settings__value">
              {new Date(license.trialStartedAt).toISOString().slice(0, 10)}
            </span>
          </div>
        )}
        {error && <div className="pro-settings__error">{error}</div>}
        <div className="pro-settings__actions">
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--primary"
            onClick={openCheckout}
            aria-label="Open PRO subscription management in a new tab"
          >
            Manage subscription
          </button>
          <button
            type="button"
            className="pro-settings__btn pro-settings__btn--ghost"
            onClick={handleDeactivate}
            disabled={busy}
            aria-label="Deactivate license"
          >
            Deactivate
          </button>
        </div>
      </div>
    );
  }

  // ── Trial (default branch — also covers 'none' as a defensive fallback,
  //    though 'none' should not normally surface because load() auto-starts
  //    the trial). ─────────────────────────────────────────────────────
  return (
    <div className="pro-settings" data-status={status}>
      <div className="pro-settings__head">
        <span className="pro-settings__title">PRO license</span>
        <PROBadge
          variant="trial"
          countdown={getTrialDaysRemaining(license) + 'd left'}
        />
      </div>
      <p className="pro-settings__hint">
        <TrialCountdown license={license} /> — full PRO access during the
        trial. Upgrade any time to keep the feature set.
      </p>
      <ul className="pro-settings__features" aria-label="PRO features">
        {(Object.keys(PRO_FEATURES) as Array<keyof typeof PRO_FEATURES>)
          .filter((k) => PRO_FEATURES[k].gate === 'async' || PRO_FEATURES[k].gate === 'sync')
          .slice(0, 4)
          .map((k) => (
            <li key={k} className="pro-settings__feature">
              <span className="pro-settings__feature-label">
                {PRO_FEATURES[k].label}
              </span>
              <span className="pro-settings__feature-hint">
                {PRO_FEATURES[k].hint}
              </span>
            </li>
          ))}
      </ul>
      <div className="pro-settings__row">
        <span className="pro-settings__label">Key</span>
        <LicenseInput
          onSubmit={handleActivate}
          disabled={busy}
          externalError={error}
        />
      </div>
      {error && <div className="pro-settings__error">{error}</div>}
      <div className="pro-settings__actions">
        <button
          type="button"
          className="pro-settings__btn pro-settings__btn--primary"
          onClick={openCheckout}
          aria-label="Open PRO checkout in a new tab"
          data-testid="pro-upgrade-btn"
        >
          Upgrade to PRO
        </button>
      </div>
      <p className="pro-settings__meta">
        Trial duration: {Math.round(TRIAL_DURATION_MS / (24 * 60 * 60 * 1000))} days
      </p>
    </div>
  );
}
