// SPDX-License-Identifier: Apache-2.0
// Pulse — clipboard helper (R176).
//
// Best-effort copyToClipboard used by the chat code-block "Copy" button.
// Modern async Clipboard API first, then falls back to the deprecated but
// still widely-supported document.execCommand('copy') path. Returns true
// on success, false on any failure. Never throws.

/**
 * Copy a plain-text string to the system clipboard.
 *
 * Tries `navigator.clipboard.writeText` first. If the modern API is
 * unavailable OR the call rejects, falls back to a hidden
 * `<textarea>` + `document.execCommand('copy')`. Both paths are
 * best-effort — any failure returns `false` rather than throwing,
 * so the caller can decide whether to show UI feedback.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Permission denied, insecure context, etc. Fall through to legacy.
    }
  }
  return legacyCopy(text);
}

function legacyCopy(text: string): boolean {
  if (typeof document === 'undefined' || !document.body) return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  // Hide off-screen but keep focusable.
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.top = '0';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  // Preserve current selection so we don't blow it away.
  const prevSelection = document.getSelection();
  const prevRange =
    prevSelection && prevSelection.rangeCount > 0
      ? prevSelection.getRangeAt(0)
      : null;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  if (prevRange && prevSelection) {
    prevSelection.removeAllRanges();
    prevSelection.addRange(prevRange);
  }
  return ok;
}
