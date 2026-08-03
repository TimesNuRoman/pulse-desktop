// SPDX-License-Identifier: Apache-2.0
// Pulse — chat code renderer (R168').
//
// react-markdown `code` component override. Inline `code` (single
// backticks) is rendered as plain text. Fenced code blocks with a
// recognised language get Tokyo-Night token spans via the hand-rolled
// syntax highlighter. Unknown languages and untagged fences render the
// raw text, escaped by React.

import type { ReactNode } from 'react';
import { highlight, getLanguage } from '../lib/syntaxHighlight';

interface CodeProps {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

/**
 * Renders the `code` element inside a react-markdown tree.
 * Used via `<ReactMarkdown components={{ code: renderCode }} />`.
 */
export function renderCode(props: CodeProps) {
  const { inline, className, children } = props;
  const codeStr = String(children ?? '').replace(/\n$/, '');

  if (inline) {
    // Inline `code` — never highlight, just render.
    return <code className={className}>{children}</code>;
  }

  const match = /language-(\w+)/.exec(className || '');
  if (match) {
    const lang = getLanguage(match[1]);
    if (lang) {
      const html = highlight(codeStr, lang);
      return (
        <code
          className={className}
          lang={lang}
          aria-label={`${lang} code block`}
          dangerouslySetInnerHTML={{ __html: html }}
        />
      );
    }
    // Unknown language — render escaped plain text inside a labeled <code>.
    return (
      <code
        className={className}
        aria-label={`${match[1]} code block`}
      >
        {codeStr}
      </code>
    );
  }

  // Fenced code without a `language-…` tag.
  return <code className={className}>{children}</code>;
}
