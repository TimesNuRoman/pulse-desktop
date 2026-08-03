// SPDX-License-Identifier: Apache-2.0
// R188: MediaRecorder + getUserMedia wrapper (port of pulse-android R172).
//
// State machine:
//
//   idle ─start()─> recording ─stop()─> stopping ─onstop─> idle
//                          \                  \
//                           \─destroy()─>      └─onerror─> error
//                            \-> idle
//
// Permission failures and MediaRecorder errors flow through the `error`
// state and the `onError` callback, so the UI can render the right inline
// message.
//
// v1: the returned Blob is captured but NOT transcribed. The caller is
// expected to insert a placeholder string into the chat input. A future
// R-round (R189+) will swap the placeholder for a Whisper.cpp STT
// pipeline that consumes the Blob and emits real text.

import { VoiceAnalyser } from './voiceAnalyser';

export type VoiceState = 'idle' | 'recording' | 'stopping' | 'error';

export interface VoiceRecorderOptions {
  /** Called on every rAF tick while in 'recording' state, with volume 0..1. */
  onVolume?: (volume: number) => void;
  /** Called whenever the state transitions. */
  onStateChange?: (state: VoiceState) => void;
  /** Called when the recorder enters 'error'. State has already been set. */
  onError?: (error: Error) => void;
}

export interface VoiceRecorderStartError extends Error {
  /** Normalized error code for UI switch. */
  code: 'permission-denied' | 'no-microphone' | 'not-supported' | 'recording-failed';
}

class StartError extends Error implements VoiceRecorderStartError {
  public code: VoiceRecorderStartError['code'];
  constructor(code: VoiceRecorderStartError['code'], message: string) {
    super(message);
    this.code = code;
    this.name = 'VoiceRecorderStartError';
  }
}

const PREFERRED_MIMETYPES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/ogg',
  'audio/mp4',
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  for (const m of PREFERRED_MIMETYPES) {
    try {
      if (MediaRecorder.isTypeSupported(m)) return m;
    } catch {
      // some webviews throw on isTypeSupported for unknown codecs
    }
  }
  return undefined;
}

function toError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * MediaRecorder + getUserMedia state machine.
 *
 * No React, no DOM access outside what's needed for `start()` (which calls
 * `navigator.mediaDevices.getUserMedia` and `new MediaRecorder`). All
 * observer notifications go through the supplied callbacks.
 */
export class VoiceRecorder {
  state: VoiceState = 'idle';

  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private analyser: VoiceAnalyser | null = null;
  private chunks: Blob[] = [];
  private rafId: number | null = null;
  private pendingStop: {
    resolve: (blob: Blob) => void;
    reject: (err: Error) => void;
  } | null = null;
  private options: VoiceRecorderOptions;
  private destroyed = false;

  constructor(options: VoiceRecorderOptions = {}) {
    this.options = options;
  }

  private setState(next: VoiceState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next);
  }

  private fail(err: Error): never {
    this.setState('error');
    this.options.onError?.(err);
    throw err;
  }

  private startVolumeLoop(): void {
    if (typeof requestAnimationFrame === 'undefined') return;
    const tick = (): void => {
      if (this.destroyed || this.state !== 'recording' || !this.analyser) {
        this.rafId = null;
        return;
      }
      const v = this.analyser.getVolume();
      this.options.onVolume?.(v);
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private cancelVolumeLoop(): void {
    if (this.rafId != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.rafId);
    }
    this.rafId = null;
  }

  private cleanupStream(): void {
    const s = this.stream;
    if (!s) return;
    try {
      s.getTracks().forEach((t) => {
        try {
          t.stop();
        } catch {
          // already stopped
        }
      });
    } catch {
      // ignore
    }
    this.stream = null;
  }

  /**
   * Begin recording. Resolves once the MediaRecorder is in 'recording'
   * state. Rejects with a `VoiceRecorderStartError` (has `.code`) on
   * permission denial, missing microphone, unsupported environment, or
   * any other getUserMedia / MediaRecorder construction failure.
   */
  async start(): Promise<void> {
    if (this.destroyed) {
      throw new Error('VoiceRecorder: destroyed');
    }
    if (this.state === 'recording' || this.state === 'stopping') {
      // already going — no-op
      return;
    }

    if (
      typeof navigator === 'undefined' ||
      !navigator.mediaDevices ||
      typeof navigator.mediaDevices.getUserMedia !== 'function'
    ) {
      const err = new StartError('not-supported', 'getUserMedia is not available in this environment');
      this.setState('error');
      this.options.onError?.(err);
      throw err;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
    } catch (e) {
      const name = (e as DOMException | Error)?.name ?? '';
      let err: StartError;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        err = new StartError('permission-denied', 'Microphone permission denied');
      } else if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        err = new StartError('no-microphone', 'No microphone found on this device');
      } else {
        err = new StartError('recording-failed', toError(e).message);
      }
      this.setState('error');
      this.options.onError?.(err);
      throw err;
    }

    if (this.destroyed) {
      // destroy() raced with the await — release the stream and bail.
      stream.getTracks().forEach((t) => t.stop());
      throw new Error('VoiceRecorder: destroyed during start');
    }

    this.stream = stream;
    this.analyser = new VoiceAnalyser(stream);
    this.chunks = [];

    const mimeType = pickMimeType();
    let rec: MediaRecorder;
    try {
      rec = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
    } catch (e) {
      this.analyser.destroy();
      this.analyser = null;
      this.cleanupStream();
      throw new StartError('recording-failed', toError(e).message);
    }
    this.recorder = rec;

    rec.ondataavailable = (ev: BlobEvent) => {
      if (ev.data && ev.data.size > 0) {
        this.chunks.push(ev.data);
      }
    };
    rec.onerror = (ev: Event) => {
      const err = (ev as ErrorEvent).error ?? new Error('MediaRecorder error');
      const pend = this.pendingStop;
      this.pendingStop = null;
      this.cancelVolumeLoop();
      this.analyser?.destroy();
      this.analyser = null;
      this.cleanupStream();
      this.recorder = null;
      this.setState('error');
      this.options.onError?.(toError(err));
      pend?.reject(toError(err));
    };
    rec.onstop = () => {
      const pend = this.pendingStop;
      this.pendingStop = null;
      const mime = rec.mimeType || mimeType || 'audio/webm';
      const blob = new Blob(this.chunks, { type: mime });
      this.chunks = [];
      this.cancelVolumeLoop();
      this.analyser?.destroy();
      this.analyser = null;
      this.cleanupStream();
      this.recorder = null;
      this.setState('idle');
      pend?.resolve(blob);
    };

    try {
      rec.start();
    } catch (e) {
      this.recorder = null;
      this.analyser.destroy();
      this.analyser = null;
      this.cleanupStream();
      throw new StartError('recording-failed', toError(e).message);
    }

    this.setState('recording');
    this.startVolumeLoop();
  }

  /**
   * Stop the current recording. Resolves with the captured audio Blob.
   * Throws if the recorder is not currently in 'recording' state.
   */
  stop(): Promise<Blob> {
    if (this.state !== 'recording' || !this.recorder) {
      return Promise.reject(new Error('VoiceRecorder: not recording'));
    }
    this.setState('stopping');
    return new Promise<Blob>((resolve, reject) => {
      this.pendingStop = { resolve, reject };
      try {
        this.recorder!.stop();
      } catch (e) {
        this.pendingStop = null;
        this.setState('error');
        this.options.onError?.(toError(e));
        reject(toError(e));
      }
    });
  }

  /**
   * Tear everything down. Idempotent. Safe to call from any state.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.cancelVolumeLoop();
    const rec = this.recorder;
    if (rec && rec.state !== 'inactive') {
      try {
        rec.stop();
      } catch {
        // already stopping or stopped
      }
    }
    this.recorder = null;
    this.analyser?.destroy();
    this.analyser = null;
    this.cleanupStream();
    this.chunks = [];
    const pend = this.pendingStop;
    this.pendingStop = null;
    pend?.reject(new Error('VoiceRecorder: destroyed'));
    if (this.state !== 'error') this.setState('idle');
  }
}
