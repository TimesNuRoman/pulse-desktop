// R89: vitest tests для low_confidence UI helpers (routing-ui.ts).
//
// Покрывает:
//   * localStorage round-trip (read/write/invalid/reset)
//   * formatChipText / formatModalTitle / routingModeCategory / explainLowConfidence
//   * Anti-emoji guard: все UI-строки не содержат emoji codepoints (Roman's rule)
//
// Тесты pure-логики, не нужен jsdom/RTL. Запускаются в node-среде vitest'а.

import { describe, test, expect, beforeEach } from 'vitest';

// Reset localStorage между тестами (in-memory fallback есть, но явно
// чистим чтобы тесты были детерминированные).
beforeEach(() => {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear();
    }
  } catch {
    /* ignore */
  }
});

import {
  formatChipText,
  formatModalTitle,
  routingModeCategory,
  explainLowConfidence,
  readRoutingOverride,
  writeRoutingOverride,
  LS_ROUTING_OVERRIDE,
} from './routing-ui';

import { routingModeFor, type RoutingMode } from './route';

// ─── Emoji-guard helper ──────────────────────────────────────────────────

/**
 * Проверяет что строка не содержит emoji-символов.
 * Emoji ranges (Unicode TR51 + common pictographs):
 *   - U+1F300..U+1F5FF  Misc Symbols and Pictographs
 *   - U+1F600..U+1F64F  Emoticons
 *   - U+1F680..U+1F6FF  Transport and Map
 *   - U+1F700..U+1F77F  Alchemical
 *   - U+1F780..U+1F7FF  Geometric Shapes Extended
 *   - U+1F800..U+1F8FF  Supplemental Arrows-C
 *   - U+1F900..U+1F9FF  Supplemental Symbols and Pictographs
 *   - U+1FA00..U+1FA6F  Chess Symbols
 *   - U+1FA70..U+1FAFF  Symbols and Pictographs Extended-A
 *   - U+2600..U+26FF    Misc Symbols (включает U+2605 ★ — black star, мы
 *                       не должны его использовать)
 *   - U+2700..U+27BF    Dingbats
 *   - U+FE0F            Variation Selector-16 (emoji presentation)
 *   - U+1F1E6..U+1F1FF  Regional Indicator Symbols (flags)
 */
const EMOJI_REGEX =
  /[\u{1F300}-\u{1F5FF}\u{1F600}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F7FF}\u{1F780}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

function expectNoEmoji(label: string, value: string): void {
  const match = value.match(EMOJI_REGEX);
  if (match) {
    throw new Error(
      `${label} contains emoji codepoint U+${match[0].codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}: "${match[0]}" in "${value}"`,
    );
  }
}

// ─── localStorage round-trip ──────────────────────────────────────────────

describe('readRoutingOverride / writeRoutingOverride', () => {
  test('returns null when localStorage is empty', () => {
    expect(readRoutingOverride()).toBeNull();
  });

  test('round-trips a valid RoutingMode', () => {
    const modes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
    for (const mode of modes) {
      writeRoutingOverride(mode);
      expect(readRoutingOverride()).toBe(mode);
    }
  });

  test('writeRoutingOverride(null) removes the key', () => {
    writeRoutingOverride('CodeEdit');
    expect(readRoutingOverride()).toBe('CodeEdit');
    writeRoutingOverride(null);
    expect(readRoutingOverride()).toBeNull();
  });

  test('returns null for invalid garbage value', () => {
    // Симулируем мусор в localStorage (например, старая версия приложения
    // или ручное редактирование через DevTools).
    try {
      localStorage.setItem(LS_ROUTING_OVERRIDE, 'NotAValidMode');
    } catch {
      /* ignore */
    }
    expect(readRoutingOverride()).toBeNull();
  });

  test('persists across multiple readRoutingOverride calls', () => {
    writeRoutingOverride('QuickAnswer');
    expect(readRoutingOverride()).toBe('QuickAnswer');
    expect(readRoutingOverride()).toBe('QuickAnswer');
    expect(readRoutingOverride()).toBe('QuickAnswer');
  });
});

// ─── Format helpers ───────────────────────────────────────────────────────

describe('formatChipText', () => {
  test('produces the expected chip text for each mode', () => {
    expect(formatChipText('CodeEdit')).toBe(
      "Smart Engine wasn't sure — routed to CodeEdit. Tap to see why.",
    );
    expect(formatChipText('Vision')).toBe(
      "Smart Engine wasn't sure — routed to Vision. Tap to see why.",
    );
    expect(formatChipText('QuickAnswer')).toBe(
      "Smart Engine wasn't sure — routed to QuickAnswer. Tap to see why.",
    );
    expect(formatChipText('Reasoning')).toBe(
      "Smart Engine wasn't sure — routed to Reasoning. Tap to see why.",
    );
    expect(formatChipText('Default')).toBe(
      "Smart Engine wasn't sure — routed to Default. Tap to see why.",
    );
  });

  test('all chip text variants contain 0 emoji codepoints', () => {
    const modes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
    for (const m of modes) {
      expectNoEmoji(`formatChipText(${m})`, formatChipText(m));
    }
  });
});

describe('formatModalTitle', () => {
  test('produces "Why {mode}?" for each mode', () => {
    expect(formatModalTitle('CodeEdit')).toBe('Why CodeEdit?');
    expect(formatModalTitle('QuickAnswer')).toBe('Why QuickAnswer?');
    expect(formatModalTitle('Default')).toBe('Why Default?');
  });

  test('all modal title variants contain 0 emoji codepoints', () => {
    const modes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
    for (const m of modes) {
      expectNoEmoji(`formatModalTitle(${m})`, formatModalTitle(m));
    }
  });
});

describe('routingModeCategory', () => {
  test('returns friendly category for each mode', () => {
    expect(routingModeCategory('CodeEdit')).toContain('code-edit');
    expect(routingModeCategory('Vision')).toContain('vision');
    expect(routingModeCategory('QuickAnswer')).toContain('quick answer');
    expect(routingModeCategory('Reasoning')).toContain('reasoning');
    expect(routingModeCategory('Default')).toContain('default fallback');
  });

  test('all category strings contain 0 emoji codepoints', () => {
    const modes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
    for (const m of modes) {
      expectNoEmoji(`routingModeCategory(${m})`, routingModeCategory(m));
    }
  });
});

describe('explainLowConfidence', () => {
  test('mentions code-parse-pending when parser did not confirm', () => {
    const text = explainLowConfidence({
      codeParseSignal: false,
      fired: ['code-edit', 'code-parse-pending'],
      score: 8,
      threshold: 5,
    });
    expect(text).toContain('code-edit intent');
    expect(text).toContain('parseable code');
  });

  test('reports no signals when fired is empty', () => {
    const text = explainLowConfidence({
      codeParseSignal: false,
      fired: [],
      score: 0,
      threshold: 5,
    });
    expect(text).toContain('No strong signals');
  });

  test('lists fired signals when present', () => {
    const text = explainLowConfidence({
      codeParseSignal: false,
      fired: ['short', 'vision'],
      score: 10,
      threshold: 5,
    });
    expect(text).toContain('short');
    expect(text).toContain('vision');
    expect(text).toContain('10/5');
  });

  test('handles codeParseSignal=true with code still uncertain', () => {
    const text = explainLowConfidence({
      codeParseSignal: true,
      fired: ['code-edit', 'code-parse-confirmed'],
      score: 5,
      threshold: 5,
    });
    expect(text).toContain('uncertain');
  });

  test('all explanation strings contain 0 emoji codepoints', () => {
    const cases: Array<{ codeParseSignal: boolean; fired: string[]; score: number; threshold: number }> = [
      { codeParseSignal: true, fired: ['x'], score: 1, threshold: 5 },
      { codeParseSignal: false, fired: ['code-parse-pending'], score: 8, threshold: 5 },
      { codeParseSignal: false, fired: [], score: 0, threshold: 5 },
      { codeParseSignal: false, fired: ['short', 'long'], score: 10, threshold: 5 },
    ];
    for (const c of cases) {
      const text = explainLowConfidence(c);
      expectNoEmoji('explainLowConfidence', text);
    }
  });
});

// ─── Anti-emoji guard (Roman's hard rule) ─────────────────────────────────

describe('anti-emoji: all UI strings are emoji-free', () => {
  test('no emoji in any format helper output (full sweep)', () => {
    const allStrings: Array<[string, string]> = [];
    const modes: RoutingMode[] = ['CodeEdit', 'Vision', 'QuickAnswer', 'Reasoning', 'Default'];
    for (const m of modes) {
      allStrings.push([`formatChipText(${m})`, formatChipText(m)]);
      allStrings.push([`formatModalTitle(${m})`, formatModalTitle(m)]);
      allStrings.push([`routingModeCategory(${m})`, routingModeCategory(m)]);
    }
    for (const c of [
      { codeParseSignal: true, fired: ['x'], score: 1, threshold: 5 },
      { codeParseSignal: false, fired: ['code-parse-pending'], score: 8, threshold: 5 },
      { codeParseSignal: false, fired: [], score: 0, threshold: 5 },
    ]) {
      allStrings.push(['explainLowConfidence', explainLowConfidence(c)]);
    }
    for (const [label, value] of allStrings) {
      expectNoEmoji(label, value);
    }
    // Sanity: at least one string was tested
    expect(allStrings.length).toBeGreaterThan(10);
  });
});

// ─── Cross-check with Rust helper (parity) ────────────────────────────────

describe('routingModeFor parity', () => {
  // Rust-side helper mapping (должно совпадать с TS).
  // Документировано в src-tauri/src/engine/smart_engine.rs::routing_mode_for
  test('TS routingModeFor matches Rust routing_mode_for mapping', () => {
    expect(routingModeFor('code')).toBe('CodeEdit');
    expect(routingModeFor('vision')).toBe('Vision');
    expect(routingModeFor('fast')).toBe('QuickAnswer');
    expect(routingModeFor('large')).toBe('Reasoning');
    expect(routingModeFor('default')).toBe('Default');
    // unknown / custom env override → Default
    expect(routingModeFor('gemma3:4b')).toBe('Default');
    expect(routingModeFor('qwen2.5-coder:7b')).toBe('Default');
    expect(routingModeFor('')).toBe('Default');
  });
});
