// SPDX-License-Identifier: Apache-2.0
// Pulse — PRO badge (R119 PRO foundation, R191 trial variant).
//
// Small pill component used next to gated features to indicate PRO status.
// Three variants:
//   * 'locked'   (default) — gray pill, feature is PRO-locked
//   * 'active'             — accent pill, feature is PRO-active (valid
//                            key or fresh trial)
//   * 'trial'              — amber pill, feature is on the auto-started
//                            14-day trial window. Surfaces a countdown
//                            string so the UI can render "TRIAL · 13d".
// Color comes from existing pulse CSS variables (--accent / --accent-2 /
// --warn) so the badge tracks the dark theme without a new palette.

import type { ProFeature } from '../../lib/license/types';
import { PRO_FEATURES } from '../../lib/pro-features';

interface PROBadgeProps {
  feature?: ProFeature;
  /** Legacy boolean — `true` ≡ 'active'. New code should pass `variant`. */
  active?: boolean;
  /** 'locked' | 'active' | 'trial'. Defaults to 'locked' (or 'active' if
   *  `active === true` is passed for backward compatibility). */
  variant?: 'locked' | 'active' | 'trial';
  /** Optional countdown string for the 'trial' variant, e.g. "13d left".
   *  Rendered after the label, separated by a middle dot. */
  countdown?: string;
  className?: string;
}

export function PROBadge({
  feature,
  active,
  variant,
  countdown,
  className,
}: PROBadgeProps) {
  // Backward compat: `active` boolean maps to 'active' variant.
  const resolvedVariant: 'locked' | 'active' | 'trial' =
    variant ?? (active ? 'active' : 'locked');
  const label = feature ? PRO_FEATURES[feature].label : 'PRO';
  const pillLabel = resolvedVariant === 'trial' ? 'TRIAL' : 'PRO';
  const title =
    resolvedVariant === 'active'
      ? `${label} is active`
      : resolvedVariant === 'trial'
        ? `${label} is on the 14-day trial${countdown ? ` (${countdown})` : ''}`
        : `${label} requires a PRO license`;
  return (
    <span
      className={`pro-badge pro-badge--${resolvedVariant}${className ? ' ' + className : ''}`}
      data-active={resolvedVariant === 'active' ? '1' : '0'}
      data-variant={resolvedVariant}
      title={title}
      aria-label={title}
    >
      {pillLabel}
      {resolvedVariant === 'trial' && countdown && (
        <span className="pro-badge__countdown" aria-hidden="true">
          {' \u00b7 '}
          {countdown}
        </span>
      )}
    </span>
  );
}
