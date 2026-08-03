// SPDX-License-Identifier: Apache-2.0
// Pulse — chat fenced code block with Copy button (R176).
//
// Used as the react-markdown `code` component override in ChatView.
// Inline `code` (single backticks) is rendered as plain text, no
// button. Fenced code blocks (triple backticks) get a Copy button in
// the top-right corner that copies the raw text to the clipboard and
// shows a "Copied!" confirmation for 2 seconds.
//
// The Copy source is always the raw `code` string — never the
// highlighted HTML — so the user gets the original source intact.

import {
  Fragment,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { copyToClipboard } from '../lib/clipboard';

interface ChatCodeBlockProps {
  inline?: boolean;
  className?: string;
  children?: ReactNode;
}

const COPY_RESET_MS = 2000;

/**
 * Render the `code` element inside a react-markdown tree.
 * Used via `<ReactMarkdown components={{ code: renderChatCode }} />`.
 */
export function renderChatCode(props: ChatCodeBlockProps) {
  const { inline, className, children } = props;
  const codeStr = String(children ?? '').replace(/\n$/, '');

  if (inline) {
    // Inline `code` — never copy, just render.
    return <code className={className}>{children}</code>;
  }

  // Fenced block. The wrapping <pre> is rendered by react-markdown's
  // default `pre` component, so we return a fragment with [button, code]
  // and the pre wraps both. The button is absolutely positioned
  // (anchored to the pre, which is position: relative via styles.css).
  return (
    <Fragment>
      {codeStr.trim().length > 0 && <CopyButton code={codeStr} />}
      <code className={className}>{codeStr}</code>
    </Fragment>
  );
}

function CopyButton({ code }: { code: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  function onClick() {
    // Fire-and-forget. copyToClipboard() is best-effort and never throws.
    copyToClipboard(code)
      .then((ok) => {
        if (!ok) return;
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), COPY_RESET_MS);
      })
      .catch(() => {
        // copyToClipboard() never rejects today, but be defensive.
      });
  }

  return (
    <button
      type="button"
      className="chat__codecopy"
      aria-label="Copy code"
      data-copied={copied ? '1' : '0'}
      onClick={onClick}
    >
      <span aria-live="polite" aria-atomic="true">
        {copied ? '✓ Copied!' : 'Copy'}
      </span>
    </button>
  );
}
