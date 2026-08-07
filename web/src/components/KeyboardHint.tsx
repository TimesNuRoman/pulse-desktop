// SPDX-License-Identifier: Apache-2.0
// Pulse desktop - R244 keyboard hint chip.
//
// A small inline chip that shows a keyboard shortcut. Rendered
// inside a list row (e.g. the chat sidebar) to communicate the
// "press this to act" affordance without adding UI chrome.
//
// Design (per the R244 brief):
//   - inner padding = sp-1 (6px) horizontally, 1px vertically
//   - font-size 10.5px so it never collides with a 12-13px title
//   - hairline 1px border, no shadow (it lives on top of a row
//     that already carries elevation)
//   - aria-label is mandatory so screen readers read the full
//     shortcut ("press Command K to focus search") instead of
//     the symbol soup ("Command K" is fine, "⌘K" alone is not)
//   - min-height 22px, min-width 22px so it stays a real
//     hit-target when the parent row wraps
//   - no emoji, no marketing copy

import { SPACING } from '../lib/spacing-tokens';

export interface KeyboardHintProps {
  /** The keys to display, e.g. ['⌘', 'K'] or ['Enter']. Order is preserved left-to-right. */
  keys: string[];
  /** Required: a screen-reader-friendly description like "Open command palette". */
  ariaLabel: string;
  /** Optional visible label that comes before the keys, e.g. "Run". */
  label?: string;
  /** Optional test id for unit tests. */
  testId?: string;
}

const innerStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '3px',
  minHeight: 22,
  minWidth: 22,
  padding: `1px ${SPACING.s1}px`,
  borderRadius: 4,
  border: '1px solid var(--border-elevated)',
  background: 'var(--surface-2)',
  color: 'var(--fg-dim)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 10.5,
  lineHeight: 1.2,
  letterSpacing: '0.02em',
  whiteSpace: 'nowrap',
  userSelect: 'none',
};

const keySepStyle: React.CSSProperties = {
  color: 'var(--fg-dim)',
  opacity: 0.5,
  fontSize: 9,
  margin: '0 1px',
};

const labelStyle: React.CSSProperties = {
  fontFamily: 'inherit',
  color: 'var(--fg-dim)',
  fontSize: 10.5,
  letterSpacing: 0,
};

export function KeyboardHint(props: KeyboardHintProps) {
  const { keys, ariaLabel, label, testId } = props;
  if (keys.length === 0) return null;

  return (
    <span
      className="kbd-hint"
      style={innerStyle}
      role="img"
      aria-label={ariaLabel}
      data-testid={testId}
    >
      {label && <span style={labelStyle}>{label}</span>}
      {label && <span style={keySepStyle} aria-hidden>·</span>}
      {keys.map((k, i) => (
        <kbd key={`${k}-${i}`} style={{ fontFamily: 'inherit', fontSize: 'inherit' }}>
          {k}
        </kbd>
      ))}
    </span>
  );
}
