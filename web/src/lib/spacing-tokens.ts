// SPDX-License-Identifier: Apache-2.0
// Pulse desktop - R244 spacing rhythm token mirror.
//
// The authoritative source of truth lives in styles/tokens.css as
// CSS custom properties (--sp-1 .. --sp-5). This file mirrors the
// SAME values as TypeScript so React components (KeyboardHint,
// EmptyState) can size themselves without a runtime CSS read.
//
// Why a TS mirror? Two reasons:
//   1. SSR-safety: window.getComputedStyle is brittle during React's
//      first render and would force a layout-flash on the empty
//      state illustration.
//   2. Testability: the test can import the actual values rather
//      than parsing a CSS string.
//
// The brief values are: 6, 12, 18, 28, 44 - the same five steps
// that appear as --sp-1 .. --sp-5 in tokens.css. If you change
// one, change the other. The CSS file's clamp() handles fluid
// scaling between 320 and 1440px viewports; this TS file holds
// the static "design intent" values for layout math (e.g. icon
// margin = sp-1, row min-height = sp-5).

export const SPACING = {
  /** 6px - tight inline gaps (icon → label, chip inner padding) */
  s1: 6,
  /** 12px - default control / list inner padding */
  s2: 12,
  /** 18px - section / content gap */
  s3: 18,
  /** 28px - between unrelated blocks */
  s4: 28,
  /** 44px - touch-target row / button min-height */
  s5: 44,
} as const;

/** Read the comment on SPACING above before changing any of these. */
export type SpacingKey = keyof typeof SPACING;
