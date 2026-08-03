// SPDX-License-Identifier: Apache-2.0
// Tests for VoiceRecorder (R188 port of pulse-android R172).
//
// Mocks navigator.mediaDevices.getUserMedia, MediaRecorder, and the Web
// Audio API (AudioContext / AnalyserNode). The mocks are stateful so we
// can drive the recorder through its full lifecycle without real I/O.

import { describe, test, expect, beforeEach, vi, afterEach } from 'vitest';
import { VoiceRecorder } from '../voiceRecorder';

// ── mock state ─────────────────────────────────────────────────────────

interface MockMediaRecorderOpts {
  ondataavailable: ((ev: BlobEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  onstop: (() => void) | null;
  startCalls: number;
  stopCalls: number;
  mimeType: string;
  state: 'inactive' | 'recording' | 'stopped' | 'paused';
  start(this: MockMediaRecorderOpts): void;
  stop(this: MockMediaRecorderOpts): void;
  pause(this: MockMediaRecorderOpts): void;
  resume(this: MockMediaRecorderOpts): void;
}

function createMockMediaRecorder(): {
  lastRecorder: (MockMediaRecorderOpts & { ctor: typeof MediaRecorder }) | null;
  isTypeSupported: (m: string) => boolean;
  setSupported: (m: string, ok: boolean) => void;
} {
  const supported = new Set<string>(['audio/webm;codecs=opus']);
  let last: (MockMediaRecorderOpts & { ctor: typeof MediaRecorder }) | null = null;
  const MockCtor = function (this: unknown, _stream: MediaStream, opts?: MediaRecorderOptions) {
    const inst: MockMediaRecorderOpts = {
      ondataavailable: null,
      onerror: null,
      onstop: null,
      startCalls: 0,
      stopCalls: 0,
      mimeType: opts?.mimeType ?? 'audio/webm',
      state: 'inactive' as const,
      start(this: MockMediaRecorderOpts): void {
        this.startCalls++;
        this.state = 'recording';
      },
      stop(this: MockMediaRecorderOpts): void {
        this.stopCalls++;
        this.state = 'stopped';
      },
      pause(this: MockMediaRecorderOpts): void {
        this.state = 'paused';
      },
      resume(this: MockMediaRecorderOpts): void {
        this.state = 'recording';
      },
    };
    last = Object.assign(inst, { ctor: MockCtor as unknown as typeof MediaRecorder });
    return inst as unknown as MediaRecorder;
  } as unknown as typeof MediaRecorder;
  // Wire globally so the recorder module can find it
  (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder =
    MockCtor;
  (globalThis as unknown as { MediaRecorder: typeof MediaRecorder & { isTypeSupported: (m: string) => boolean } })
    .MediaRecorder.isTypeSupported = (m: string) => supported.has(m);
  return {
    get lastRecorder() {
      return last;
    },
    isTypeSupported: (m: string) => supported.has(m),
    setSupported: (m: string, ok: boolean) => {
      if (ok) supported.add(m);
      else supported.delete(m);
    },
  };
}

function installGetUserMedia(stream: MediaStream | null, error: Error | null = null): void {
  const md = (navigator as unknown as { mediaDevices: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } }).mediaDevices;
  md.getUserMedia = vi.fn(async () => {
    if (error) throw error;
    if (!stream) throw new Error('no stream');
    return stream;
  }) as unknown as typeof navigator.mediaDevices.getUserMedia;
}

function removeGetUserMedia(): void {
  delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
}

function installFakeAudioContext(): void {
  // The VoiceAnalyser only needs createMediaStreamSource, createAnalyser,
  // close, state. Provide no-ops so it never blocks.
  const Ctx = function () {
    return {
      createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
      createAnalyser: () => ({
        fftSize: 64,
        frequencyBinCount: 32,
        getByteFrequencyData: () => {},
        disconnect() {},
      }),
      async close() {},
      state: 'running',
    };
  };
  (window as unknown as { AudioContext: unknown }).AudioContext = Ctx;
}

function makeFakeStream(): MediaStream & { _stoppedTracks: number } {
  let stopped = 0;
  const track = {
    stop: vi.fn(() => {
      stopped++;
    }),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  };
  return {
    _stoppedTracks: stopped,
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream & { _stoppedTracks: number };
}

async function flushMicrotasks(): Promise<void> {
  // Two microtask ticks: promise chain + setImmediate (rAF mock).
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

// ── tests ──────────────────────────────────────────────────────────────

describe('VoiceRecorder', () => {
  let originalMediaRecorder: typeof MediaRecorder | undefined;
  let originalGetUserMedia: typeof navigator.mediaDevices.getUserMedia | undefined;
  let originalMediaDevices: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } | undefined;
  let originalAudioContext: unknown;

  beforeEach(() => {
    // happy-dom does not ship navigator.mediaDevices by default; install
    // a fresh object on every test so we can swap getUserMedia in/out.
    const md = (navigator as unknown as { mediaDevices?: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } }).mediaDevices;
    originalMediaDevices = md;
    (navigator as unknown as { mediaDevices: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } }).mediaDevices = {
      getUserMedia: undefined as unknown as typeof navigator.mediaDevices.getUserMedia,
    };
    originalMediaRecorder = (globalThis as unknown as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    originalGetUserMedia = (navigator as unknown as { mediaDevices: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } })
      .mediaDevices.getUserMedia;
    originalAudioContext = (window as unknown as { AudioContext?: unknown }).AudioContext;
    installFakeAudioContext();
    // requestAnimationFrame polyfill: call tick synchronously on next microtask
    (globalThis as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame = ((cb: FrameRequestCallback) => {
      return setTimeout(() => cb(performance.now()), 0) as unknown as number;
    }) as unknown as typeof requestAnimationFrame;
    (globalThis as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame = ((h: number) => {
      clearTimeout(h);
    }) as unknown as typeof cancelAnimationFrame;
  });

  afterEach(() => {
    if (originalMediaRecorder) {
      (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder = originalMediaRecorder;
    } else {
      delete (globalThis as unknown as { MediaRecorder?: unknown }).MediaRecorder;
    }
    if (originalMediaDevices) {
      (navigator as unknown as { mediaDevices: { getUserMedia: typeof navigator.mediaDevices.getUserMedia } }).mediaDevices = originalMediaDevices;
    } else {
      delete (navigator as unknown as { mediaDevices?: unknown }).mediaDevices;
    }
    if (originalAudioContext) {
      (window as unknown as { AudioContext: unknown }).AudioContext = originalAudioContext;
    } else {
      delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    }
  });

  test('initial state is idle', () => {
    const r = new VoiceRecorder();
    expect(r.state).toBe('idle');
  });

  test('start() requests mic, transitions to recording, calls onStateChange', async () => {
    const mocks = createMockMediaRecorder();
    const stream = makeFakeStream();
    installGetUserMedia(stream);
    const states: string[] = [];
    const r = new VoiceRecorder({ onStateChange: (s) => states.push(s) });
    await r.start();
    expect(r.state).toBe('recording');
    expect(states).toEqual(['recording']);
    expect(mocks.lastRecorder).not.toBeNull();
    expect(mocks.lastRecorder!.startCalls).toBe(1);
    r.destroy();
  });

  test('start() with no getUserMedia rejects with not-supported', async () => {
    removeGetUserMedia();
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'not-supported' });
    expect(r.state).toBe('error');
  });

  test('start() with NotAllowedError rejects with permission-denied', async () => {
    createMockMediaRecorder();
    const err = Object.assign(new Error('denied'), { name: 'NotAllowedError' });
    installGetUserMedia(null, err);
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'permission-denied' });
    expect(r.state).toBe('error');
  });

  test('start() with NotFoundError rejects with no-microphone', async () => {
    createMockMediaRecorder();
    const err = Object.assign(new Error('no mic'), { name: 'NotFoundError' });
    installGetUserMedia(null, err);
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'no-microphone' });
    expect(r.state).toBe('error');
  });

  test('start() with SecurityError rejects with permission-denied', async () => {
    createMockMediaRecorder();
    const err = Object.assign(new Error('security'), { name: 'SecurityError' });
    installGetUserMedia(null, err);
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('start() with generic Error rejects with recording-failed', async () => {
    createMockMediaRecorder();
    const err = Object.assign(new Error('boom'), { name: 'OtherError' });
    installGetUserMedia(null, err);
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'recording-failed' });
  });

  test('start() invokes onError callback on failure', async () => {
    createMockMediaRecorder();
    const err = Object.assign(new Error('nope'), { name: 'NotAllowedError' });
    installGetUserMedia(null, err);
    const onError = vi.fn();
    const r = new VoiceRecorder({ onError });
    await expect(r.start()).rejects.toBeDefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]![0] as { code: string }).code).toBe('permission-denied');
  });

  test('start() is a no-op if already recording', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await r.start();
    const first = mocks.lastRecorder;
    await r.start();
    expect(mocks.lastRecorder).toBe(first); // same recorder, not a new one
    r.destroy();
  });

  test('start() throws after destroy()', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    r.destroy();
    await expect(r.start()).rejects.toThrow(/destroyed/i);
  });

  test('stop() returns the assembled blob and resets state to idle', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await r.start();
    const rec = mocks.lastRecorder!;
    const stopPromise = r.stop();
    expect(r.state).toBe('stopping');
    // Simulate MediaRecorder firing ondataavailable then onstop
    const chunk = new Blob(['abcd'], { type: rec.mimeType });
    rec.ondataavailable?.({ data: chunk } as unknown as BlobEvent);
    rec.onstop?.();
    const blob = await stopPromise;
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.type).toContain('webm');
    expect(r.state).toBe('idle');
  });

  test('stop() rejects when not recording', async () => {
    const r = new VoiceRecorder();
    await expect(r.stop()).rejects.toThrow(/not recording/i);
  });

  test('destroy() while recording stops the recorder and cleans up', async () => {
    const mocks = createMockMediaRecorder();
    const stream = makeFakeStream();
    installGetUserMedia(stream);
    const r = new VoiceRecorder();
    await r.start();
    const rec = mocks.lastRecorder!;
    r.destroy();
    expect(rec.stopCalls).toBeGreaterThanOrEqual(1);
    expect(stream.getTracks()[0]!.stop).toHaveBeenCalled();
  });

  test('destroy() is idempotent', () => {
    const r = new VoiceRecorder();
    r.destroy();
    r.destroy(); // no throw
  });

  test('onVolume callback fires after start()', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const volumes: number[] = [];
    const r = new VoiceRecorder({ onVolume: (v) => volumes.push(v) });
    await r.start();
    // rAF tick: wait long enough for at least one tick
    await new Promise((r2) => setTimeout(r2, 20));
    r.destroy();
    // We can't guarantee a tick happens (analyser is mocked as zero),
    // but we can guarantee that no volume >1 was emitted.
    for (const v of volumes) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
    // The mock analyser returns 0 — at least one tick is expected.
    expect(volumes.length).toBeGreaterThan(0);
    expect(mocks.lastRecorder).not.toBeNull();
  });

  test('mimeType fallback chain uses isTypeSupported', async () => {
    const mocks = createMockMediaRecorder();
    // Only audio/webm is supported (not opus, not mp4, not ogg).
    mocks.setSupported('audio/webm;codecs=opus', false);
    mocks.setSupported('audio/webm', true);
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await r.start();
    expect(mocks.lastRecorder!.mimeType).toBe('audio/webm');
    r.destroy();
  });

  test('MediaRecorder onerror transitions to error and rejects stop()', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await r.start();
    const rec = mocks.lastRecorder!;
    const stopPromise = r.stop();
    const err = new Error('encoder exploded');
    rec.onerror?.({ error: err } as unknown as Event);
    await expect(stopPromise).rejects.toBe(err);
    expect(r.state).toBe('error');
  });

  test('MediaRecorder construction failure rejects with recording-failed', async () => {
    const original = (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder;
    (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder = (function () {
      throw new Error('MediaRecorder ctor failed');
    }) as unknown as typeof MediaRecorder;
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await expect(r.start()).rejects.toMatchObject({ code: 'recording-failed' });
    (globalThis as unknown as { MediaRecorder: typeof MediaRecorder }).MediaRecorder = original;
  });

  test('dataavailable with empty data is ignored', async () => {
    const mocks = createMockMediaRecorder();
    installGetUserMedia(makeFakeStream());
    const r = new VoiceRecorder();
    await r.start();
    const rec = mocks.lastRecorder!;
    const stopPromise = r.stop();
    rec.ondataavailable?.({ data: new Blob([], { type: 'audio/webm' }) } as unknown as BlobEvent);
    rec.ondataavailable?.({ data: null } as unknown as BlobEvent);
    rec.ondataavailable?.({ data: undefined } as unknown as BlobEvent);
    rec.ondataavailable?.({ data: new Blob(['x'], { type: 'audio/webm' }) } as unknown as BlobEvent);
    rec.onstop?.();
    const blob = await stopPromise;
    // Only the non-empty chunks should be in the blob.
    expect(blob.size).toBeGreaterThan(0);
    expect(blob.size).toBeLessThan(100);
  });
});
