// SPDX-License-Identifier: Apache-2.0
// Pulse — syntaxHighlight tests (R168').
//
// Hand-rolled regex tokenizer. We verify both the public API contract
// (alias map, escape behavior) and the per-language token output for
// the cases that matter for the chat UI.

import { describe, test, expect } from 'vitest';
import {
  highlight,
  getLanguage,
  LANGUAGES,
  LANGUAGE_ALIASES,
} from '../syntaxHighlight';

describe('getLanguage — alias normalization', () => {
  test('py → python', () => {
    expect(getLanguage('py')).toBe('python');
  });

  test('ts → typescript', () => {
    expect(getLanguage('ts')).toBe('typescript');
  });

  test('sh / shell / zsh → bash', () => {
    expect(getLanguage('sh')).toBe('bash');
    expect(getLanguage('shell')).toBe('bash');
    expect(getLanguage('zsh')).toBe('bash');
  });

  test('js / jsx → javascript, tsx → typescript', () => {
    expect(getLanguage('js')).toBe('javascript');
    expect(getLanguage('jsx')).toBe('javascript');
    expect(getLanguage('tsx')).toBe('typescript');
  });

  test('unknown language → null', () => {
    expect(getLanguage('html')).toBeNull();
    expect(getLanguage('rust')).toBeNull();
    expect(getLanguage('')).toBeNull();
  });

  test('alias map is case-insensitive', () => {
    expect(getLanguage('PYTHON')).toBe('python');
    expect(getLanguage('TypeScript')).toBe('typescript');
  });
});

describe('highlight — python', () => {
  test('print("hi") highlights the string and the function name', () => {
    const html = highlight('print("hi")', 'python');
    // String content is HTML-escaped at emission (the `"` becomes `&quot;`).
    expect(html).toContain('<span class="tok-str">&quot;hi&quot;</span>');
    // `print` is a Python builtin → tok-fn (blue).
    expect(html).toMatch(/<span class="tok-fn">print<\/span>/);
  });

  test('# comment line is highlighted as comment, code after stays plain', () => {
    const html = highlight('# comment\ncode', 'python');
    expect(html).toContain('<span class="tok-com"># comment</span>');
    expect(html).toContain('code');
    // The "code" identifier must NOT be wrapped in a comment span.
    expect(html).not.toContain('<span class="tok-com">code</span>');
  });

  test('"not_a_keyword" does not false-positive on Python keyword `not`', () => {
    // `not` is a Python keyword but `_` is a word char, so the word
    // boundary must prevent the match.
    const html = highlight('not_a_keyword', 'python');
    expect(html).not.toContain('<span class="tok-kw">not</span>');
    expect(html).not.toContain('<span class="tok-kw">not_a_keyword</span>');
  });

  test('PEP-515 underscored numbers match as a single number token', () => {
    const html = highlight('1_000_000', 'python');
    expect(html).toBe('<span class="tok-num">1_000_000</span>');
  });

  test('"x = None" highlights `None` as a keyword (purple)', () => {
    const html = highlight('x = None', 'python');
    expect(html).toContain('<span class="tok-kw">None</span>');
  });
});

describe('highlight — javascript / typescript', () => {
  test('"const x = 42" highlights `const` as keyword and `42` as number', () => {
    const html = highlight('const x = 42', 'javascript');
    expect(html).toContain('<span class="tok-kw">const</span>');
    expect(html).toContain('<span class="tok-num">42</span>');
  });

  test('escaped quote inside a JS string is preserved inside the string span', () => {
    // Input is the 6-char string: " a \ " b "
    // The whole literal (including the embedded escaped quote) must end
    // up inside one <span class="tok-str">…</span> wrapper, and inner
    // chars are HTML-escaped at emission.
    const html = highlight('"a\\"b"', 'javascript');
    expect(html).toBe('<span class="tok-str">&quot;a\\&quot;b&quot;</span>');
  });

  test('single-quoted JS string is highlighted as a string', () => {
    const html = highlight("'hi'", 'javascript');
    // Quotes are HTML-escaped to `&#39;` at emission.
    expect(html).toBe('<span class="tok-str">&#39;hi&#39;</span>');
  });

  test('TypeScript `interface` is a keyword (not just a builtin)', () => {
    const html = highlight('interface Foo {}', 'typescript');
    expect(html).toContain('<span class="tok-kw">interface</span>');
  });
});

describe('highlight — bash / json', () => {
  test('bash: "echo $x" highlights echo as a builtin', () => {
    const html = highlight('echo $x', 'bash');
    expect(html).toMatch(/<span class="tok-fn">echo<\/span>/);
  });

  test('json: 42 is a number, true/false/null are keywords', () => {
    const html42 = highlight('42', 'json');
    expect(html42).toBe('<span class="tok-num">42</span>');

    const htmlTrue = highlight('true', 'json');
    expect(htmlTrue).toBe('<span class="tok-kw">true</span>');

    const htmlNull = highlight('null', 'json');
    expect(htmlNull).toBe('<span class="tok-kw">null</span>');
  });

  test('json has no comment pattern (//foo is not a comment here)', () => {
    // JSON's spec doesn't allow comments; in our highlighter //foo
    // should be emitted as plain text (the // will be 2 plain chars).
    const html = highlight('//foo', 'json');
    expect(html).not.toContain('<span class="tok-com">');
  });
});

describe('highlight — safety / output', () => {
  test('unknown language returns HTML-escaped raw text (no spans)', () => {
    const html = highlight('<script>', 'html');
    expect(html).toBe('&lt;script&gt;');
    expect(html).not.toContain('<span');
  });

  test('HTML special chars inside a known language are escaped at emission', () => {
    // Python string with < and > — must be escaped, not raw.
    const html = highlight('x = "<a>"', 'python');
    expect(html).toContain('&lt;a&gt;');
    expect(html).not.toContain('<a>');
  });

  test('all known languages are registered in LANGUAGES', () => {
    for (const name of ['python', 'javascript', 'typescript', 'bash', 'json'] as const) {
      expect(LANGUAGES[name]).toBeDefined();
      expect(LANGUAGES[name].name).toBe(name);
    }
  });

  test('alias map covers every registered language', () => {
    // Every canonical Language must be reachable from at least one alias.
    for (const name of Object.keys(LANGUAGES)) {
      const hit = Object.values(LANGUAGE_ALIASES).includes(name as any);
      expect(hit).toBe(true);
    }
  });
});
