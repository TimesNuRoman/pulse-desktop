// SPDX-License-Identifier: Apache-2.0
// Pulse — code block syntax highlighting (R168').
//
// 0 npm deps. Hand-rolled regex tokenizer. Tokyo Night token colors come
// from CSS variables in web/src/styles.css. We emit `<span class="tok-X">`
// wrappers and HTML-escape at emission time (so input is treated as raw
// text, never as HTML).
//
// Token priority (the order alternation is checked at each position):
//   comment → string (dq / sq / backtick) → number → keyword → builtin
//
// Comments and strings must win before identifier classes so we never
// tokenize inside a literal or a comment.
//
// Public API:
//   highlight(code, lang)   — returns HTML string with <span> wrappers
//   getLanguage(raw)        — canonical Language or null (alias-aware)
//   LANGUAGES               — registered language specs
//   LANGUAGE_ALIASES        — alias → canonical name map

export type Language = 'python' | 'javascript' | 'typescript' | 'bash' | 'json';

export interface LanguageSpec {
  readonly name: Language;
  /** Single-line comment pattern without anchors (e.g. `#[^\n]*` or `//[^\n]*`). null = no comments. */
  readonly comment: string | null;
  /** Reserved words. Matched as whole words only. */
  readonly keywords: readonly string[];
  /** Built-in identifiers (functions / types). Matched as whole words only. */
  readonly builtins: readonly string[];
}

/* ------------------------------------------------------------------ */
/* Token patterns                                                       */
/* ------------------------------------------------------------------ */

// Strings: double-quoted, single-quoted, backticked. No backreferences
// (R155 android anti-pattern). Escaped chars (`\"`, `\\`, etc.) handled
// via the `\\.` alternation. Newlines are NOT allowed inside a string,
// so a missing closing quote can't swallow the rest of the file.
const STR_DQ = '"(?:\\\\.|[^"\\\\\\n])*"';
const STR_SQ = "'(?:\\\\.|[^'\\\\\\n])*'";
const STR_BT = '`(?:\\\\.|[^`\\\\])*`';

// Numbers: PEP-515 underscored digits (1_000_000), optional decimal and
// exponent. Word boundaries on both sides so `42abc` does not match.
const NUMBER = '\\b\\d(?:[\\d_]*\\d)?(?:\\.\\d(?:[\\d_]*\\d)?)?(?:[eE][+-]?\\d+)?\\b';

// Identifier for the "plain text" fallthrough. Used so we don't wrap
// every non-token char in a span.
const IDENT = '[A-Za-z_$][A-Za-z0-9_$]*';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ------------------------------------------------------------------ */
/* Language specs                                                       */
/* ------------------------------------------------------------------ */

const LANG_PYTHON: LanguageSpec = {
  name: 'python',
  comment: '#[^\\n]*',
  keywords: [
    'False', 'None', 'True',
    'and', 'as', 'assert', 'async', 'await',
    'break', 'class', 'continue',
    'def', 'del',
    'elif', 'else', 'except',
    'finally', 'for', 'from',
    'global',
    'if', 'import', 'in', 'is',
    'lambda',
    'nonlocal', 'not', 'or',
    'pass',
    'raise', 'return',
    'try',
    'while', 'with',
    'yield',
    'match', 'case',
  ],
  builtins: [
    'abs', 'all', 'any', 'ascii',
    'bin', 'bool', 'bytearray', 'bytes',
    'callable', 'chr', 'classmethod', 'compile', 'complex',
    'delattr', 'dict', 'dir', 'divmod',
    'enumerate', 'eval', 'exec',
    'filter', 'float', 'format', 'frozenset',
    'getattr', 'globals',
    'hasattr', 'hash', 'help', 'hex',
    'id', 'input', 'int', 'isinstance', 'issubclass', 'iter',
    'len', 'list', 'locals',
    'map', 'max', 'memoryview', 'min',
    'next',
    'object', 'oct', 'open', 'ord',
    'pow', 'print', 'property',
    'range', 'repr', 'reversed', 'round',
    'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super',
    'tuple', 'type',
    'vars',
    'zip',
  ],
};

const LANG_JAVASCRIPT: LanguageSpec = {
  name: 'javascript',
  comment: '//[^\\n]*',
  keywords: [
    'async', 'await',
    'break',
    'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do',
    'else', 'export', 'extends',
    'false', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof',
    'let',
    'new', 'null',
    'of', 'return',
    'static', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof',
    'undefined', 'var', 'void',
    'while', 'with',
    'yield',
  ],
  builtins: [
    'Array', 'Boolean',
    'Date', 'decodeURI', 'decodeURIComponent',
    'encodeURI', 'encodeURIComponent', 'Error', 'eval',
    'Function',
    'globalThis',
    'Infinity', 'isFinite', 'isNaN',
    'JSON',
    'Map', 'Math',
    'NaN', 'Number',
    'Object',
    'parseFloat', 'parseInt', 'Promise', 'Proxy',
    'Reflect', 'RegExp',
    'Set', 'String', 'Symbol',
    'TypeError',
  ],
};

const LANG_TYPESCRIPT: LanguageSpec = {
  name: 'typescript',
  comment: '//[^\\n]*',
  keywords: [
    // JS reserved
    'async', 'await',
    'break',
    'case', 'catch', 'class', 'const', 'continue',
    'debugger', 'default', 'delete', 'do',
    'else', 'export', 'extends',
    'false', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof',
    'let',
    'new', 'null',
    'of', 'return',
    'static', 'super', 'switch',
    'this', 'throw', 'true', 'try', 'typeof',
    'undefined', 'var', 'void',
    'while', 'with',
    'yield',
    // TS-specific contextual keywords
    'abstract', 'as',
    'declare', 'enum', 'implements', 'interface',
    'is', 'keyof', 'namespace', 'never',
    'private', 'protected', 'public', 'readonly',
    'type', 'unknown',
  ],
  builtins: LANG_JAVASCRIPT.builtins,
};

const LANG_BASH: LanguageSpec = {
  name: 'bash',
  comment: '#[^\\n]*',
  keywords: [
    'if', 'then', 'else', 'elif', 'fi',
    'for', 'while', 'until', 'do', 'done',
    'case', 'esac', 'in',
    'function',
    'return',
    'break', 'continue',
    'export', 'local',
  ],
  builtins: [
    'alias', 'awk', 'basename', 'bg', 'cat', 'cd', 'chmod', 'chown', 'cp', 'curl',
    'dirname', 'echo', 'env', 'eval', 'exec', 'exit', 'export', 'false',
    'find', 'grep', 'head', 'kill', 'ln', 'ls',
    'mkdir', 'mv', 'printf', 'pwd', 'read', 'rm', 'rmdir', 'sed',
    'set', 'shift', 'sleep', 'source', 'tail', 'tar', 'test', 'touch', 'true',
  ],
};

const LANG_JSON: LanguageSpec = {
  name: 'json',
  comment: null,
  keywords: ['true', 'false', 'null'],
  builtins: [],
};

export const LANGUAGES: Readonly<Record<Language, LanguageSpec>> = Object.freeze({
  python: LANG_PYTHON,
  javascript: LANG_JAVASCRIPT,
  typescript: LANG_TYPESCRIPT,
  bash: LANG_BASH,
  json: LANG_JSON,
});

export const LANGUAGE_ALIASES: Readonly<Record<string, Language>> = Object.freeze({
  py: 'python',
  python: 'python',
  python3: 'python',
  js: 'javascript',
  jsx: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  typescript: 'typescript',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  bash: 'bash',
  json: 'json',
});

/* ------------------------------------------------------------------ */
/* Tokenizer                                                            */
/* ------------------------------------------------------------------ */

/** Returns the canonical Language for `raw`, or null if unsupported. */
export function getLanguage(raw: string): Language | null {
  if (!raw) return null;
  const key = raw.toLowerCase();
  if (key in LANGUAGE_ALIASES) return LANGUAGE_ALIASES[key];
  return null;
}

/** Build the per-language mega-regex. Sticky (`y`) so we walk forward. */
function compile(lang: LanguageSpec): RegExp {
  const parts: string[] = [];
  if (lang.comment) {
    parts.push(`(?<comment>${lang.comment})`);
  }
  parts.push(
    `(?<stringDQ>${STR_DQ})`,
    `(?<stringSQ>${STR_SQ})`,
    `(?<stringBT>${STR_BT})`,
  );
  if (lang.keywords.length) {
    parts.push(`(?<keyword>\\b(?:${lang.keywords.join('|')})\\b)`);
  }
  if (lang.builtins.length) {
    parts.push(`(?<builtin>\\b(?:${lang.builtins.join('|')})\\b)`);
  }
  parts.push(`(?<number>${NUMBER})`);
  parts.push(`(?<ident>${IDENT})`);
  return new RegExp(parts.join('|'), 'gy');
}

/** Tokenize `code` for the given language spec. Returns escaped HTML. */
function highlightImpl(code: string, lang: LanguageSpec): string {
  const re = compile(lang);
  const out: string[] = [];
  let pos = 0;
  while (pos < code.length) {
    re.lastIndex = pos;
    const m = re.exec(code);
    if (m !== null && m.index === pos) {
      // Match starts at the current position. Emit the token.
      const text = m[0];
      const g = m.groups ?? {};
      if (g.comment) {
        out.push(`<span class="tok-com">${escapeHtml(text)}</span>`);
      } else if (g.stringDQ || g.stringSQ || g.stringBT) {
        out.push(`<span class="tok-str">${escapeHtml(text)}</span>`);
      } else if (g.keyword) {
        out.push(`<span class="tok-kw">${escapeHtml(text)}</span>`);
      } else if (g.builtin) {
        out.push(`<span class="tok-fn">${escapeHtml(text)}</span>`);
      } else if (g.number) {
        out.push(`<span class="tok-num">${escapeHtml(text)}</span>`);
      } else {
        // ident — no token class, just escape and emit
        out.push(escapeHtml(text));
      }
      pos += text.length;
    } else {
      // No match at `pos`. Emit one char as plain escaped text and
      // advance. (Sticky `y` regex returns null instead of skipping,
      // so we have to nudge forward ourselves.)
      out.push(escapeHtml(code[pos]));
      pos++;
    }
  }
  return out.join('');
}

/**
 * Highlight `code` as `lang`. Returns an HTML string with
 * `<span class="tok-X">…</span>` wrappers. Unknown / null languages
 * return the code HTML-escaped with no spans (caller is expected to
 * wrap in `<pre><code>` if it wants block rendering).
 */
export function highlight(code: string, lang: string): string {
  const canonical = getLanguage(lang);
  if (!canonical) return escapeHtml(code);
  return highlightImpl(code, LANGUAGES[canonical]);
}
