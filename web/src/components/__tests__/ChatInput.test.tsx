// SPDX-License-Identifier: Apache-2.0
// Pulse - ChatInput component tests (R160).
//
// R160 ships the paste-image preview + send-to-vision flow inside
// ChatInput.tsx. These tests pin the public behaviour:
//
//   1. Empty paste (no image) → no preview shown.
//   2. Paste image → preview shown with dataURL src.
//   3. Click × on preview → preview cleared.
//   4. Paste image, then paste another → preview REPLACED, not stacked.
//   5. Send with image + text → calls visionApi.sendImageWithPrompt with
//      the right args and bubbles the response up via onVisionResponse.
//   6. Send with image only (no text) → uses placeholder
//      "What's in this image?".
//
// We mock the helpers by replacing the imported bindings directly with
// `vi.spyOn`-style reassignment. vi.mock at the top of the file was
// flaky in this test runner (it interfered with createRoot); inline
// reassignment is simpler and reliable.

// React 18 `act` requires this flag. happy-dom doesn't set it by default.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { act } from 'react';
import { ChatInput, type VisionResponse } from '../ChatInput';
import * as clipboardModule from '../../lib/clipboard';
import * as visionApiModule from '../../lib/visionApi';

// --- Per-test state ------------------------------------------------------

const mockReadImage = vi.fn(async (_e: ClipboardEvent) => null as string | null);
const mockSendImage = vi.fn(
  async (req: { imageBase64: string; prompt: string; model?: string }) => {
    return `[mock-vision] ${req.prompt}`;
  },
);

let originalReadImage: typeof clipboardModule.readImageFromClipboardEvent;
let originalSendImage: typeof visionApiModule.sendImageWithPrompt;

function setReadImageMock(fn: typeof clipboardModule.readImageFromClipboardEvent) {
  // ESM module exports are read-only in Vitest — bypass with
  // Object.defineProperty. This replaces the export on the live module
  // object, so the import in ChatInput.tsx sees the mock.
  Object.defineProperty(clipboardModule, 'readImageFromClipboardEvent', {
    value: fn,
    writable: true,
    configurable: true,
  });
}
function setSendImageMock(fn: typeof visionApiModule.sendImageWithPrompt) {
  Object.defineProperty(visionApiModule, 'sendImageWithPrompt', {
    value: fn,
    writable: true,
    configurable: true,
  });
}

beforeEach(() => {
  // Save originals and install mocks.
  originalReadImage = clipboardModule.readImageFromClipboardEvent;
  originalSendImage = visionApiModule.sendImageWithPrompt;
  setReadImageMock(((e: ClipboardEvent) => mockReadImage(e)) as typeof clipboardModule.readImageFromClipboardEvent);
  setSendImageMock(((req) => mockSendImage(req) as Promise<string>) as typeof visionApiModule.sendImageWithPrompt);

  mockReadImage.mockReset();
  mockSendImage.mockReset();
  mockReadImage.mockResolvedValue(null); // default: no image
  mockSendImage.mockImplementation(async (req) => `[mock-vision] ${req.prompt}`);
});

afterEach(() => {
  // Restore originals.
  setReadImageMock(originalReadImage);
  setSendImageMock(originalSendImage);
});

// --- Harness --------------------------------------------------------------

interface Harness {
  root: Root;
  container: HTMLDivElement;
}

function mount(element: React.ReactElement): Harness {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(element);
  });
  return { root, container };
}

function unmount(h: Harness) {
  act(() => {
    h.root.unmount();
  });
  document.body.removeChild(h.container);
}

function inputEl(h: Harness): HTMLInputElement {
  const el = h.container.querySelector<HTMLInputElement>('[data-testid="chat-input"]');
  if (!el) throw new Error('chat-input not found');
  return el;
}

function sendBtn(h: Harness): HTMLButtonElement {
  const el = h.container.querySelector<HTMLButtonElement>('[data-testid="chat-send"]');
  if (!el) throw new Error('chat-send not found');
  return el;
}

function previewEl(h: Harness): HTMLElement | null {
  return h.container.querySelector<HTMLElement>('[data-testid="pasted-image-preview"]');
}

function removeBtn(h: Harness): HTMLButtonElement | null {
  return h.container.querySelector<HTMLButtonElement>('[data-testid="pasted-image-remove"]');
}

async function flush() {
  // Let microtasks (async paste + async vision) drain.
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function firePaste(target: HTMLInputElement): void {
  // Build a fake ClipboardEvent. The component reads `clipboardData.items`
  // — we attach a stub via Object.defineProperty since some happy-dom
  // builds ignore the second arg. The mock is what actually controls
  // return value.
  const evt = new ClipboardEvent('paste', {
    bubbles: true,
    cancelable: true,
  });
  // mockReadImage ignores the event; tests just toggle its return.
  act(() => {
    target.dispatchEvent(evt);
  });
}

// --- Tests ----------------------------------------------------------------

describe('ChatInput - R160 paste-image preview', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = mount(
      <ChatInput
        value=""
        onChange={() => {}}
        onSubmitText={() => {}}
        onVisionResponse={() => {}}
        onError={() => {}}
        busy={false}
        provider="ollama"
        model="gemma2:2b"
        visionAvailable
        visionModel="gemma3:4b"
      />,
    );
  });

  afterEach(() => {
    unmount(harness);
  });

  test('empty paste (no image) → no preview shown', async () => {
    // mockReadImage returns null (default).
    firePaste(inputEl(harness));
    await flush();
    expect(previewEl(harness)).toBeNull();
  });

  test('paste image → preview shown with dataURL src', async () => {
    const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAAASUVORK5CYII=';
    mockReadImage.mockResolvedValueOnce(dataUrl);

    firePaste(inputEl(harness));
    await flush();

    const preview = previewEl(harness);
    expect(preview).not.toBeNull();
    const img = preview!.querySelector<HTMLImageElement>('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe(dataUrl);
    // a11y: role="status" + aria-label on the preview container.
    expect(preview?.getAttribute('role')).toBe('status');
    expect(preview?.getAttribute('aria-label')).toBeTruthy();
  });

  test('click × on preview → preview cleared', async () => {
    mockReadImage.mockResolvedValueOnce('data:image/png;base64,abc');
    firePaste(inputEl(harness));
    await flush();
    expect(previewEl(harness)).not.toBeNull();

    const btn = removeBtn(harness);
    expect(btn).not.toBeNull();
    await act(async () => {
      btn!.click();
    });
    expect(previewEl(harness)).toBeNull();
  });

  test('paste image, then paste another → preview replaced (not stacked)', async () => {
    const first = 'data:image/png;base64,FIRST';
    const second = 'data:image/png;base64,SECOND';
    mockReadImage.mockResolvedValueOnce(first);
    firePaste(inputEl(harness));
    await flush();
    expect(previewEl(harness)!.querySelector('img')?.getAttribute('src')).toBe(first);

    mockReadImage.mockResolvedValueOnce(second);
    firePaste(inputEl(harness));
    await flush();

    // Still ONE preview, with the second src.
    const previews = harness.container.querySelectorAll(
      '[data-testid="pasted-image-preview"]',
    );
    expect(previews).toHaveLength(1);
    expect(previews[0].querySelector('img')?.getAttribute('src')).toBe(second);
  });
});

describe('ChatInput - R160 send to vision', () => {
  let harness: Harness;
  let onVisionResponse: (r: VisionResponse) => void;
  let onSubmitText: (t: string) => void;
  let onError: (msg: string) => void;
  let onChange: (v: string) => void;

  beforeEach(() => {
    onVisionResponse = vi.fn();
    onSubmitText = vi.fn();
    onError = vi.fn();
    onChange = vi.fn();

    harness = mount(
      <ChatInput
        value="Describe this UI"
        onChange={onChange}
        onSubmitText={onSubmitText}
        onVisionResponse={onVisionResponse}
        onError={onError}
        busy={false}
        provider="ollama"
        model="gemma2:2b"
        visionAvailable
        visionModel="gemma3:4b"
      />,
    );
  });

  afterEach(() => {
    unmount(harness);
  });

  test('send with image + text → calls visionApi with correct args and bubbles response', async () => {
    const dataUrl = 'data:image/png;base64,FAKEDATA';
    mockReadImage.mockResolvedValueOnce(dataUrl);
    firePaste(inputEl(harness));
    await flush();
    expect(previewEl(harness)).not.toBeNull();

    // Click send. The submit handler is async (awaits vision API).
    await act(async () => {
      sendBtn(harness).click();
    });
    await flush();

    // visionApi called with the pasted image (dataURL prefix included;
    // the real sendImageWithPrompt strips it internally before POSTing).
    // We don't re-implement the strip in the mock — the test pins the
    // contract that ChatInput passes the dataURL through unchanged.
    expect(mockSendImage).toHaveBeenCalledTimes(1);
    const call = mockSendImage.mock.calls[0][0];
    expect(call.imageBase64).toBe(dataUrl);
    expect(call.prompt).toBe('Describe this UI');
    expect(call.model).toBe('gemma3:4b');

    // Response bubbled up.
    expect(onVisionResponse).toHaveBeenCalledTimes(1);
    const arg = (onVisionResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.userText).toBe('Describe this UI');
    expect(arg.imageDataUrl).toBe(dataUrl);
    expect(arg.assistantText).toBe('[mock-vision] Describe this UI');

    // Preview + input cleared after success.
    expect(previewEl(harness)).toBeNull();
    expect(onChange).toHaveBeenCalledWith('');
  });

  test('send with image only (no text) → uses placeholder "What\'s in this image?"', async () => {
    // Reset the harness with empty value (no text).
    unmount(harness);
    onChange = vi.fn();
    onVisionResponse = vi.fn();
    harness = mount(
      <ChatInput
        value=""
        onChange={onChange}
        onSubmitText={onSubmitText}
        onVisionResponse={onVisionResponse}
        onError={onError}
        busy={false}
        provider="ollama"
        model="gemma2:2b"
        visionAvailable
        visionModel="gemma3:4b"
      />,
    );

    mockReadImage.mockResolvedValueOnce('data:image/png;base64,PNGONLY');
    firePaste(inputEl(harness));
    await flush();
    expect(previewEl(harness)).not.toBeNull();

    await act(async () => {
      sendBtn(harness).click();
    });
    await flush();

    expect(mockSendImage).toHaveBeenCalledTimes(1);
    const call = mockSendImage.mock.calls[0][0];
    expect(call.prompt).toBe("What's in this image?");
    // The userText bubbled up is empty (no typed text), but the vision
    // request used the placeholder.
    const arg = (onVisionResponse as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(arg.userText).toBe('');
    expect(arg.assistantText).toBe("[mock-vision] What's in this image?");
  });
});
