// SPDX-License-Identifier: Apache-2.0
// Pulse - clipboard helpers (combined R160 + R176).
//
// R160 contributed `readImageFromClipboardEvent` (paste-image -> data URL)
// R176 contributed `copyToClipboard` (text -> system clipboard, with
// modern API + legacy fallback).
//
// Both functions are best-effort and never throw. The file is
// intentionally small: two pure helpers, no shared state, no
// dependencies.

/** MIME types we accept as a pasted image. */
const IMAGE_MIME_TYPES = new Set<string>([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/webp',
  'image/gif',
]);

/**
 * Read an image from a `ClipboardEvent`'s `clipboardData` and return it as
 * a data URL. Returns `null` if the paste contains no image, or the image
 * type isn't supported, or reading fails.
 *
 * Usage:
 *   <input onPaste={async (e) => {
 *     const url = await readImageFromClipboardEvent(e.nativeEvent);
 *     if (url) setPastedImage(url);
 *   }} />
 */
export async function readImageFromClipboardEvent(
  event: ClipboardEvent,
): Promise<string | null> {
  const items = event.clipboardData?.items;
  if (!items || items.length === 0) return null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.kind !== 'file') continue;
    const type = item.type;
    if (!IMAGE_MIME_TYPES.has(type)) continue;
    const blob = item.getAsFile();
    if (!blob) continue;
    return blobToDataUrl(blob);
  }
  return null;
}

/** Convert a Blob to a data URL via FileReader (Promise wrapper). */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result === 'string') resolve(result);
      else reject(new Error('FileReader did not return a string'));
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error('FileReader error'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Copy a plain-text string to the system clipboard.
 *
 * Tries `navigator.clipboard.writeText` first. If the modern API is
 * unavailable OR the call rejects, falls back to a hidden
 * `<textarea>` + `document.execCommand('copy')`. Both paths are
 * best-effort - any failure returns `false` rather than throwing,
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
  if (typeof document === 'undefined') return false;
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  ta.style.pointerEvents = 'none';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  document.body.removeChild(ta);
  return ok;
}
