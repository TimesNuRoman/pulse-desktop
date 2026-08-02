// SPDX-License-Identifier: Apache-2.0
// Pulse — upgrade modal (R119 PRO foundation).
//
// Shown when a free user tries to use a PRO feature. R119 stub: opens
// `https://buy.polar.sh/pulse-monthly` in a new tab (the Polar.sh product
// hasn't been created yet — this is a placeholder URL per GTM plan).

import type { ProFeature } from '../../lib/license/types';
import { PRO_FEATURES } from '../../lib/pro-features';

const PRO_URL = 'https://buy.polar.sh/pulse-monthly';

interface UpgradeModalProps {
  /** Which feature triggered the gate. */
  feature: ProFeature;
  /** Why we're showing the modal (auto vs explicit). */
  reason?: 'auto' | 'click';
  onClose: () => void;
  onActivated?: () => void;
}

export function UpgradeModal({ feature, reason, onClose, onActivated }: UpgradeModalProps) {
  const info = PRO_FEATURES[feature];

  function openCheckout() {
    if (typeof window !== 'undefined') {
      window.open(PRO_URL, '_blank', 'noopener,noreferrer');
    }
  }

  return (
    <div
      className="upgrade-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="upgrade-modal__title"
    >
      <div className="upgrade-modal__backdrop" onClick={onClose} />
      <div className="upgrade-modal__panel">
        <div className="upgrade-modal__head">
          <h2 id="upgrade-modal__title" className="upgrade-modal__title">
            {info.label}
          </h2>
          <button
            className="upgrade-modal__close"
            onClick={onClose}
            aria-label="Close"
            type="button"
          >
            ×
          </button>
        </div>
        <div className="upgrade-modal__body">
          <p className="upgrade-modal__hint">{info.hint}</p>
          <p className="upgrade-modal__fallback">
            <span className="upgrade-modal__fallback-label">Free tier:</span>{' '}
            {info.fallback}
          </p>
          {reason === 'auto' && (
            <p className="upgrade-modal__note">
              This feature is part of PRO. Open the checkout page to get a license key.
            </p>
          )}
        </div>
        <div className="upgrade-modal__actions">
          <button
            type="button"
            className="upgrade-modal__btn upgrade-modal__btn--ghost"
            onClick={onClose}
          >
            Not now
          </button>
          <button
            type="button"
            className="upgrade-modal__btn upgrade-modal__btn--primary"
            onClick={openCheckout}
          >
            Get PRO
          </button>
        </div>
        {onActivated && (
          <button
            type="button"
            className="upgrade-modal__activated-link"
            onClick={onActivated}
          >
            I have a key — paste it
          </button>
        )}
      </div>
    </div>
  );
}
