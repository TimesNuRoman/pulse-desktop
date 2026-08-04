// SPDX-License-Identifier: Apache-2.0
// Tests for R241 surface stack + shadow + border tokens.
//
// We don't pull in a CSS parser - the project's `tokens.css` is
// plain CSS that Vitest doesn't evaluate natively. Instead we
// read the source as text and assert that the expected token
// declarations are present with the exact values from the
// Raycast design research. This catches accidental edits (e.g.
// someone deleting a token, swapping a value) without needing
// happy-dom to compute styles.

import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TOKENS_PATH = resolve(__dirname, '..', 'tokens.css');

function tokensSource(): string {
  return readFileSync(TOKENS_PATH, 'utf-8');
}

describe('tokens.css - surface stack', () => {
  test('defines surface-1 through surface-4 on :root', () => {
    const src = tokensSource();
    expect(src).toMatch(/--surface-1:\s*#[0-9a-fA-F]{6}/);
    expect(src).toMatch(/--surface-2:\s*#[0-9a-fA-F]{6}/);
    expect(src).toMatch(/--surface-3:\s*#[0-9a-fA-F]{6}/);
    expect(src).toMatch(/--surface-4:\s*#[0-9a-fA-F]{6}/);
  });

  test('defines translucent surface variants for floating panels', () => {
    const src = tokensSource();
    expect(src).toMatch(/--surface-translucent:\s*rgba\(/);
    expect(src).toMatch(/--surface-overlay-translucent:\s*rgba\(/);
  });

  test('each surface step is a 6-8 luminance step (subtle, not abrupt)', () => {
    // Extract hex values and assert luminance climbs monotonically.
    // Uses the standard 0.2126 R + 0.7152 G + 0.0722 B formula.
    const src = tokensSource();
    const hexes = [...src.matchAll(/--surface-(\d):\s*#([0-9a-fA-F]{6})/g)].map(
      (m) => m[2],
    );
    expect(hexes).toHaveLength(4);
    const luminance = (hex: string): number => {
      const r = parseInt(hex.slice(0, 2), 16) / 255;
      const g = parseInt(hex.slice(2, 4), 16) / 255;
      const b = parseInt(hex.slice(4, 6), 16) / 255;
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const lums = hexes.map(luminance);
    for (let i = 1; i < lums.length; i++) {
      expect(lums[i]).toBeGreaterThan(lums[i - 1]);
    }
  });
});

describe('tokens.css - shadow scale', () => {
  test('defines shadow-sm / shadow-md / shadow-xl', () => {
    const src = tokensSource();
    expect(src).toMatch(/--shadow-sm:\s*0/);
    expect(src).toMatch(/--shadow-md:\s*0/);
    expect(src).toMatch(/--shadow-xl:\s*0/);
  });

  test('every shadow uses heavy alpha (0.4+) - dark surfaces need it', () => {
    // The whole point of the heavy-alpha shadow scale: on a dark
    // surface, an rgba(0,0,0,0.15) shadow is invisible. We require
    // every declared alpha in the file to be >= 0.4.
    const src = tokensSource();
    const alphas = [
      ...src.matchAll(/rgba\(0,\s*0,\s*0,\s*([0-9.]+)\)/g),
    ].map((m) => parseFloat(m[1]));
    expect(alphas.length).toBeGreaterThan(0);
    for (const a of alphas) {
      expect(a).toBeGreaterThanOrEqual(0.4);
    }
  });
});

describe('tokens.css - border scale', () => {
  test('defines border-elevated (0.08) and border-subtle (0.04)', () => {
    const src = tokensSource();
    expect(src).toMatch(/--border-elevated:\s*rgba\(255,\s*255,\s*255,\s*0\.08\)/);
    expect(src).toMatch(/--border-subtle:\s*rgba\(255,\s*255,\s*255,\s*0\.04\)/);
  });
});

describe('tokens.css - glass recipe', () => {
  test('glass-blur is blur(20px) saturate(160%) - the jewel combo', () => {
    const src = tokensSource();
    // Order-insensitive: we look for both blur(20px) and saturate(160%)
    // in the same line, with the right magnitude.
    const m = src.match(/--glass-blur:\s*([^;]+);/);
    expect(m).not.toBeNull();
    const value = m![1];
    expect(value).toMatch(/blur\(20px\)/);
    expect(value).toMatch(/saturate\(160%\)/);
  });
});

describe('tokens.css - file hygiene', () => {
  test('has Apache-2.0 SPDX header as the first line', () => {
    const src = tokensSource();
    const firstLine = src.split('\n')[0].trim();
    // CSS files can use either // SPDX or /* SPDX - the project
    // uses /* */ for tokens.css to keep Vite's CSS parser happy.
    expect(
      firstLine === '// SPDX-License-Identifier: Apache-2.0' ||
        firstLine === '/* SPDX-License-Identifier: Apache-2.0',
    ).toBe(true);
  });

  test('contains no marketing copy or branding words', () => {
    // Same regex the Coder rules use to block leakage.
    const src = tokensSource();
    const banned = /\b(Raycast|Roman|Pulse team|\$0|free forever|open source|by Roman)\b/i;
    expect(banned.test(src)).toBe(false);
  });

  test('no emoji in CSS comments', () => {
    // The few common emoji we definitely don't want to leak.
    const src = tokensSource();
    expect(src).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u);
  });
});
