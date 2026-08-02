// SPDX-License-Identifier: Apache-2.0
// Pulse — PRO badge (R119 PRO foundation).
//
// Small pill component used next to gated features to indicate PRO status.
// Color comes from existing pulse CSS variables (--accent / --accent-2) so
// the badge tracks the dark theme without a new palette.

import type { ProFeature } from '../../lib/license/types';
import { PRO_FEATURES } from '../../lib/pro-features';

interface PROBadgeProps {
  feature?: ProFeature;
  /** When true, render the "active" green PRO pill. Default false. */
  active?: boolean;
  className?: string;
}

export function PROBadge({ feature, active, className }: PROBadgeProps) {
  const label = feature ? PRO_FEATURES[feature].label : 'PRO';
  return (
    <span
      className={`pro-badge${active ? ' pro-badge--active' : ''}${className ? ' ' + className : ''}`}
      data-active={active ? '1' : '0'}
      title={active ? `${label} is active` : `${label} requires a PRO license`}
    >
      PRO
    </span>
  );
}
