// SPDX-License-Identifier: Apache-2.0
// Pulse - ChatInput component (R160).
//
// R160 splits the chat input + send button + paste-image handling out of
// the monolithic ChatView.tsx into its own component. The motivation:
//   1. The image-paste UX (preview, remove, send to vision) is a focused
//      unit that deserves isolated tests — it touches paste events, the
//      Clipboard API, and the vision model call. Testing through ChatView
//      would require mounting the whole 800-line form.
//   2. ChatView was getting hard to scan — the bottom-bar logic (screenshot,
//      attach, mic, send, autostart) was tangled with chat state.
//
// Layout: ChatInput renders a self-contained <form> with the text input
// + send button. The parent (ChatView) provides the surrounding toolbar
// buttons (📸 screenshot, 📎 attach, 👁️ vision-describe, 🎤 mic, ⚙
// autostart) and the vision badge as `children`. The form-onSubmit
// behaviour stays local: pressing Enter on the input OR clicking the
// send button calls ChatInput's onSubmit, which decides between the
// text path (parent's onSubmitText) and the vision path (direct call to
// visionApi.sendImageWithPrompt).
//
// On a successful vision round-trip the response is bubbled up via
// `onVisionResponse({ userText, imageDataUrl, assistantText })`. The
// parent ChatView appends both bubbles (user + assistant) to the chat
// list. Errors are surfaced via `onError(message)`.

import { useState, useRef, type FormEvent, type ClipboardEvent, type ReactNode } from 'react';
import { readImageFromClipboardEvent } from '../lib/clipboard';
import {
  sendImageWithPrompt,
  VisionError,
  type VisionRequest,
} from '../lib/visionApi';

export interface VisionResponse {
  /** The text the user typed (may be empty if they pasted an image only). */
  userText: string;
  /** The pasted image as a data URL — parent renders it in the user bubble. */
  imageDataUrl: string;
  /** The vision model's text reply — parent renders it in the assistant bubble. */
  assistantText: string;
}

export interface ChatInputProps {
  /** Current input value (controlled by parent). */
  value: string;
  /** Setter for the input value. */
  onChange: (next: string) => void;
  /** Called when the user submits plain text (no pasted image). */
  onSubmitText: (text: string) => void;
  /**
   * Called after a successful vision round-trip. Parent appends the user
   * bubble (with the image) and the assistant bubble (with the reply).
   */
  onVisionResponse: (resp: VisionResponse) => void;
  /** Called when a vision request fails — surface a friendly error. */
  onError: (message: string) => void;
  /** Disables the input + send button while a request is in flight. */
  busy: boolean;
  /** Provider name shown in the placeholder (e.g. "ollama"). */
  provider: string;
  /** Active text model name shown in the placeholder. */
  model: string;
  /** Whether a vision-capable model is configured — gates the paste feature. */
  visionAvailable: boolean;
  /** Vision model name — used for the paste-image send. */
  visionModel: string;
  /** Optional override for the Ollama base URL (default: http://127.0.0.1:11434). */
  visionBaseUrl?: string;
  /** Optional placeholder override. */
  placeholder?: string;
  /** Toolbar buttons rendered to the LEFT of the input (screenshot, attach, etc.). */
  leftToolbar?: ReactNode;
  /** Toolbar buttons rendered to the RIGHT of the input (vision badge, autostart, stop). */
  rightToolbar?: ReactNode;
  /** Optional ref to the input element (for programmatic focus from parent, e.g. mic start). */
  inputRef?: React.RefObject<HTMLInputElement>;
}

export function ChatInput(props: ChatInputProps) {
  const {
    value,
    onChange,
    onSubmitText,
    onVisionResponse,
    onError,
    busy,
    provider,
    model,
    visionAvailable,
    visionModel,
    visionBaseUrl,
    placeholder,
    leftToolbar,
    rightToolbar,
    inputRef: externalInputRef,
  } = props;

  const [pastedImage, setPastedImage] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  // Optional external ref (parent may want to focus the input programmatically,
  // e.g. when STT recording starts). If not provided, we use our own ref for
  // internal focus-on-remove.
  const internalInputRef = useRef<HTMLInputElement | null>(null);
  const inputRef = externalInputRef ?? internalInputRef;

  async function onPaste(e: ClipboardEvent<HTMLInputElement>) {
    // Only handle image pastes. Text paste goes through default browser
    // behaviour — we MUST NOT call preventDefault() for text, otherwise
    // the typed text wouldn't end up in the input.
    if (!visionAvailable) return;
    const url = await readImageFromClipboardEvent(e.nativeEvent);
    if (!url) return;
    e.preventDefault();
    // R160 spec: "No paste duplication — pasting an image replaces the
    // current preview (don't stack)". Replace, don't append.
    setPastedImage(url);
  }

  function onRemoveImage() {
    setPastedImage(null);
    inputRef.current?.focus();
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    const text = value.trim();

    // No image + no text → no-op (also keeps the send button disabled
    // state consistent — but guard anyway in case of programmatic submit).
    if (!pastedImage && !text) return;
    if (busy || pasteBusy) return;

    if (pastedImage) {
      // Vision path: send image + prompt to Ollama, bubble result up.
      const prompt = text || "What's in this image?";
      setPasteBusy(true);
      try {
        const req: VisionRequest = {
          imageBase64: pastedImage,
          prompt,
          model: visionModel,
        };
        if (visionBaseUrl) req.baseUrl = visionBaseUrl;
        const assistantText = await sendImageWithPrompt(req);
        onVisionResponse({
          userText: text,
          imageDataUrl: pastedImage,
          assistantText,
        });
        // Reset: clear input + preview. Errors keep the preview so the
        // user can retry without re-pasting.
        setPastedImage(null);
        onChange('');
      } catch (err) {
        const msg =
          err instanceof VisionError
            ? err.message
            : `Vision: ${(err as Error).message}`;
        onError(msg);
      } finally {
        setPasteBusy(false);
      }
      return;
    }

    // Plain text path — let the parent handle the agent loop.
    onSubmitText(text);
    onChange('');
  }

  const showPlaceholder =
    placeholder ??
    (busy
      ? 'Pulse отвечает…'
      : `Спросить Pulse (${provider}, ${model}${visionAvailable ? ' · vision' : ''})…`);

  return (
    <>
      {/* R160: inline pasted-image preview, sits above the input form, just
          like chat__attach for file attachments. role="status" so screen
          readers announce "Image attached" on mount. */}
      {pastedImage && (
        <div
          className="chat__attach"
          data-testid="pasted-image-preview"
          role="status"
          aria-label="Изображение готово к отправке"
        >
          <div className="chat__attachhead">
            <span className="chat__attachcap">Изображение из буфера</span>
            <button
              type="button"
              className="chat__attachclose"
              onClick={onRemoveImage}
              title="Убрать изображение"
              aria-label="Remove image"
              data-testid="pasted-image-remove"
            >
              ✕
            </button>
          </div>
          <img
            className="chat__image chat__image--paste"
            src={pastedImage}
            alt="Вставленное изображение"
          />
        </div>
      )}

      <form className="chat__inputrow" onSubmit={onSubmit}>
        {leftToolbar}
        <input
          ref={inputRef}
          className="chat__input"
          type="text"
          inputMode="text"
          enterKeyHint="send"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="sentences"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onPaste={onPaste}
          placeholder={showPlaceholder}
          disabled={busy || pasteBusy}
          data-testid="chat-input"
        />
        {rightToolbar}
        <button
          className="chat__send"
          type="submit"
          disabled={busy || pasteBusy || (!value.trim() && !pastedImage)}
          title="Отправить"
          data-testid="chat-send"
        >
          {pasteBusy ? '…' : '➤'}
        </button>
      </form>
    </>
  );
}
