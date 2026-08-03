// SPDX-License-Identifier: Apache-2.0
// R188: Web Audio API volume analyser (port of pulse-android R172).
//
// Wraps AudioContext + MediaStreamSource + AnalyserNode and exposes a
// normalized 0..1 volume reading for the current mic input frame. Used by
// the voice button (R188) to drive a real-time waveform overlay while the
// user is recording. The MediaStream source comes from
// navigator.mediaDevices.getUserMedia() (see voiceRecorder.ts).
//
// Graceful fallback: if AudioContext is unavailable (jsdom, ancient
// webview, or after the user denied permissions before any context was
// opened) `getVolume()` always returns 0 and `destroy()` is a no-op. This
// matches the behaviour the editor expects when the audio pipeline is
// offline: zero signal, no crashes, the UI shows flat bars.

interface AnalyserLike {
  fftSize: number;
  frequencyBinCount: number;
  getByteFrequencyData: (array: Uint8Array) => void;
  connect: (target: AnalyserLike) => void;
  disconnect: () => void;
}

interface AudioContextLike {
  createMediaStreamSource: (stream: MediaStream) => AnalyserLike;
  createAnalyser: () => AnalyserLike;
  close: () => Promise<void>;
  state?: string;
}

function resolveAudioContextCtor(): (new () => AudioContextLike) | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    AudioContext?: new () => AudioContextLike;
    webkitAudioContext?: new () => AudioContextLike;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/**
 * Start analysing a MediaStream.
 *
 * The caller owns the stream (it was created via getUserMedia inside
 * voiceRecorder). When `destroy()` is called we disconnect the source
 * node and close the context, but we do NOT call
 * `stream.getTracks().stop()` — that's the recorder's responsibility.
 * Splitting the two prevents the recorder from losing the stream
 * mid-encoding if the analyser is torn down first.
 */
export class VoiceAnalyser {
  private ctx: AudioContextLike | null = null;
  private source: AnalyserLike | null = null;
  private analyser: AnalyserLike | null = null;
  private buffer: Uint8Array | null = null;
  private stream: MediaStream;
  private trackListeners: Array<() => void> = [];
  private stopped = false;

  constructor(stream: MediaStream) {
    this.stream = stream;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) {
      // No AudioContext support — getVolume() will always return 0.
      return;
    }

    let ctx: AudioContextLike;
    let source: AnalyserLike;
    let analyser: AnalyserLike;
    let buffer: Uint8Array;
    try {
      ctx = new Ctor();
      source = ctx.createMediaStreamSource(stream);
      analyser = ctx.createAnalyser();
      // fftSize=64 → 32 frequency bins. Plenty for a 7-bar visualization
      // where each bar averages a few bins. Lower than the default 2048
      // so the browser doesn't burn cycles on a tiny ui overlay.
      analyser.fftSize = 64;
      buffer = new Uint8Array(analyser.frequencyBinCount);
      // Connect source → analyser. We do NOT connect the analyser to
      // destination because we don't want the mic to play through the
      // speakers.
      source.connect(analyser);
    } catch {
      // Some browsers throw on createMediaStreamSource if the stream has
      // no audio track (e.g. the user revoked permission between
      // getUserMedia and now). Treat as "no signal" and leave everything
      // null; getVolume() returns 0 and destroy() is a safe no-op.
      return;
    }

    this.ctx = ctx;
    this.source = source;
    this.analyser = analyser;
    this.buffer = buffer;

    // Auto-stop when the stream's tracks end. Catches the case where the
    // OS revokes mic access mid-recording (another app took over the mic)
    // without waiting for the consumer to notice.
    if (typeof stream.getTracks === 'function') {
      for (const track of stream.getTracks()) {
        const onEnd = (): void => {
          this.destroy();
        };
        track.addEventListener('ended', onEnd);
        this.trackListeners.push(() => track.removeEventListener('ended', onEnd));
      }
    }
  }

  /**
   * Current frame volume, normalized to [0, 1]. Uses the maximum bin
   * amplitude (R172 behaviour): a single loud band pushes the bar to the
   * top, which reads better on a 7-bar visualization than an RMS average.
   */
  getVolume(): number {
    if (this.stopped || !this.analyser || !this.buffer) return 0;
    try {
      this.analyser.getByteFrequencyData(this.buffer);
    } catch {
      // The native side can throw if the stream ended between two frames.
      return 0;
    }
    let max = 0;
    for (let i = 0; i < this.buffer.length; i++) {
      const v = this.buffer[i] ?? 0;
      if (v > max) max = v;
    }
    return max / 255;
  }

  /**
   * Detach the source and close the AudioContext. Idempotent.
   */
  destroy(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const off of this.trackListeners) off();
    this.trackListeners.length = 0;
    try {
      this.source?.disconnect();
    } catch {
      // already disconnected
    }
    try {
      this.analyser?.disconnect();
    } catch {
      // already disconnected
    }
    this.source = null;
    this.analyser = null;
    this.buffer = null;
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) {
      // close() returns a promise we deliberately don't await — destroy()
      // must be synchronous for the caller's state machine. The context
      // teardown happens in the background; the analyser is already
      // detached.
      void ctx.close().catch(() => {
        // context may already be closed if the tab backgrounded
      });
    }
    // Note: do NOT stop the stream's tracks here. The VoiceRecorder owns
    // them and decides when to release the mic. Splitting ownership keeps
    // the recorder from losing the stream mid-encoding if the analyser
    // happens to be torn down first.
    void this.stream;
  }
}
