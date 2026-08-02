// SPDX-License-Identifier: Apache-2.0
// Pulse — code intelligence layer (R82 / R119).
//
// This module is the TS-level wrapper around the Rust `parse_code` command.
// It exposes a *narrow, opinionated* API for the UI: "give me symbols +
// references for this source".
//
// What is FREE (no gate):
//   * The Rust `parse_code` itself — used by Smart Engine for code-edit
//     detection. Architecture doc: "Tree-sitter core (the parser is free;
//     what is PRO is the intelligence layer on top — symbol extraction,
//     cross-file refs, semantic search)."
//
// What is PRO (gated):
//   * extractSymbols()    — function/class/import names + spans.
//   * findReferences()    — cross-file references (R82 deferred).
//   * semanticSearch()    — natural-language search over symbols.
//
// R119 stub: extractSymbols works (calls parse_code) but the cross-file
// features return empty. Gates throw ProRequiredError to the UI, which
// shows the UpgradeModal.

import { invoke } from '@tauri-apps/api/core';
import { licenseStore } from '../license/store';
import type { ProFeature } from '../license/types';

const isTauri =
  typeof window !== 'undefined' &&
  (Boolean((window as any).__TAURI_INTERNALS__) ||
    Boolean((window as any).__TAURI__));

/** A single symbol extracted from a source file. */
export interface CodeSymbol {
  name: string;
  kind: 'function' | 'class' | 'method' | 'variable' | 'import';
  startLine: number;
  endLine: number;
}

/** Result of the Rust parse_code command. Mirrors src-tauri/src/lib.rs. */
interface RustParseResult {
  language: string;
  symbols: CodeSymbol[];
  has_code_construct: boolean;
}

/** Extract named symbols (functions, classes, imports) from a source file.
 *  PRO feature. Throws ProRequiredError for free users. */
export async function extractSymbols(
  source: string,
  language: string,
): Promise<CodeSymbol[]> {
  licenseStore.requirePro('code-intel');
  if (!isTauri) {
    // Dev-mode fallback: regex-only (intentionally primitive — it is the
    // "free" path; PRO gets the real thing via the Rust call).
    return stubRegexExtract(source, language);
  }
  const r = await invoke<RustParseResult>('parse_code', {
    source,
    language,
  });
  return r.symbols ?? [];
}

/** Find references to a symbol across multiple files.
 *  PRO feature. R82 deferred: returns empty array and gates. */
export async function findReferences(
  symbol: string,
  _files: Array<{ path: string; source: string }>,
): Promise<Array<{ path: string; line: number }>> {
  licenseStore.requirePro('code-intel');
  // R119: stub. R82 follow-up: real cross-file search via Tantivy / sqlite-fts.
  return [];
}

/** Semantic search over an indexed code corpus.
 *  PRO feature. R82 deferred: stub. */
export async function semanticSearch(
  query: string,
  _corpus: string[],
): Promise<Array<{ path: string; snippet: string; score: number }>> {
  licenseStore.requirePro('code-intel');
  return [];
}

/** Map a ProFeature to the gate site (helper for ProRequiredError catches). */
export function gateForFeature(_feature: ProFeature): ProFeature {
  return 'code-intel';
}

// ─── Stub regex extractor (free tier path, intentionally rough) ──────────

function stubRegexExtract(source: string, language: string): CodeSymbol[] {
  const out: CodeSymbol[] = [];
  const lines = source.split('\n');
  // English / Russian comments tolerated; only pattern is rough by design.
  if (language === 'rust') {
    const re = /^\s*(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/;
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (m) out.push({ name: m[1], kind: 'function', startLine: i + 1, endLine: i + 1 });
    });
  } else if (language === 'typescript' || language === 'javascript') {
    const re =
      /^\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][A-Za-z0-9_$]*)|^[\s]*(?:export\s+)?class\s+([A-Za-z_$][A-Za-z0-9_$]*)/;
    lines.forEach((line, i) => {
      const m = re.exec(line);
      if (!m) return;
      const name = m[1] ?? m[2];
      if (!name) return;
      out.push({
        name,
        kind: m[2] ? 'class' : 'function',
        startLine: i + 1,
        endLine: i + 1,
      });
    });
  }
  return out;
}
