// SPDX-License-Identifier: Apache-2.0
// Pulse - clipboard image reader (R160).
//
// Detects when the user pastes an image (Ctrl+V / Cmd+V) and converts it
// to a data URL the rest of the app can render in an <img> tag. The
// browser's `paste` event exposes `clipboardData.items` with image types
// (image/png, image/jpeg, image/webp) — we walk that list, read the first
// matching item as a Blob, and FileReader.readAsDataURL gives us the
// data URL. No external deps, no async clipboard API permissions needed.
//
// The async `navigator.clipboard.read()` API is intentionally NOT used
// here — it requires a permission grant in some browsers, fires errors
// that we then have to swallow, and the `paste` event is what we already
// have access to when the user explicitly pastes into our input.

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
