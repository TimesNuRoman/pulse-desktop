// SPDX-License-Identifier: Apache-2.0
// Pulse desktop - R244 empty-state illustration.
//
// Renders a small inline SVG (paper-plane, 64x64) with a slow 4s
// float animation, plus a title and an optional hint. Used wherever
// a list is empty (chat sidebar, search results, etc.) to make the
// "nothing here yet" state feel designed rather than dropped in.
//
// Design (per the R244 brief):
//   - 64x64 inline SVG, 1.5px stroke, currentColor, rounded caps
//   - 4s subtle vertical float (translateY -3px → 0 → -3px), loops
//   - respects prefers-reduced-motion (no float, opacity-only)
//   - the SVG itself is `aria-hidden` because the title text already
//     carries the meaning to assistive tech
//   - no emoji, no marketing copy

import { SPACING } from '../lib/spacing-tokens';

export interface EmptyStateProps {
  /** Headline shown under the illustration, e.g. "No saved chats yet". */
  title: string;
  /** Optional supporting copy, e.g. "Press the plus button to start a new one". */
  hint?: string;
  /** Optional test id for unit tests. */
  testId?: string;
  /** Illustration variant. Defaults to "plane". */
  illustration?: 'plane' | 'circle' | 'square';
}

const wrapStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  padding: `${SPACING.s4}px ${SPACING.s3}px`,
  gap: SPACING.s2,
  textAlign: 'center',
  userSelect: 'none',
  // Animation lives on a CSS class so reduced-motion can flip it
  // without re-rendering. The keyframes are defined in styles.css
  // (.empty-state__float).
};

const illustrationStyle: React.CSSProperties = {
  display: 'block',
  width: 64,
  height: 64,
  color: 'var(--fg-dim)',
  opacity: 0.85,
  marginBottom: SPACING.s1,
};

const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 500,
  color: 'var(--fg)',
  lineHeight: 1.4,
  margin: 0,
};

const hintStyle: React.CSSProperties = {
  fontSize: 11.5,
  color: 'var(--fg-dim)',
  lineHeight: 1.5,
  margin: 0,
  maxWidth: 240,
};

function Illustration({ variant }: { variant: 'plane' | 'circle' | 'square' }) {
  // All variants share: 1.5px stroke, currentColor, rounded caps.
  // The viewBox is 64x64 and the SVG is 64x64 on screen.
  if (variant === 'circle') {
    return (
      <svg
        className="empty-state__float"
        style={illustrationStyle}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <circle cx="32" cy="32" r="22" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="32" cy="32" r="12" stroke="currentColor" strokeWidth="1.5" />
        <circle cx="32" cy="32" r="3" fill="currentColor" />
      </svg>
    );
  }
  if (variant === 'square') {
    return (
      <svg
        className="empty-state__float"
        style={illustrationStyle}
        viewBox="0 0 64 64"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        aria-hidden
      >
        <rect
          x="14"
          y="14"
          width="36"
          height="36"
          rx="6"
          stroke="currentColor"
          strokeWidth="1.5"
        />
        <path
          d="M22 32h20M32 22v20"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        />
      </svg>
    );
  }
  // Default: paper plane. Three strokes that read as a folded plane
  // viewed from the side. currentColor + 1.5px + rounded caps.
  return (
    <svg
      className="empty-state__float"
      style={illustrationStyle}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
    >
      <path
        d="M8 32L56 12L42 52L30 36L8 32Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <path
        d="M30 36L56 12"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function EmptyState(props: EmptyStateProps) {
  const { title, hint, testId, illustration = 'plane' } = props;
  return (
    <div
      className="empty-state"
      data-testid={testId ?? 'empty-state'}
      style={wrapStyle}
    >
      <Illustration variant={illustration} />
      <p style={titleStyle}>{title}</p>
      {hint && <p style={hintStyle}>{hint}</p>}
    </div>
  );
}
