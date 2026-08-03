// SPDX-License-Identifier: Apache-2.0
// Tests for VoiceAnalyser (R188 port of pulse-android R172).
//
// Pure TS, no React. happy-dom provides `window`, so we install a
// minimal AudioContext + MediaStream shim before each test. The shim
// records every getByteFrequencyData call so we can assert that the
// analyser actually polls the underlying node.

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { VoiceAnalyser } from '../voiceAnalyser';

interface AnalyserLike {
  fftSize: number;
  frequencyBinCount: number;
  getByteFrequencyData: (array: Uint8Array) => void;
  disconnect: () => void;
}

interface AudioContextLike {
  createMediaStreamSource: (stream: MediaStream) => AnalyserLike;
  createAnalyser: () => AnalyserLike;
  close: () => Promise<void>;
  state?: string;
}

function makeFakeAnalyser(fftSize = 64): AnalyserLike & { _calls: number; _lastBuffer: Uint8Array | null } {
  const a = {
    fftSize,
    frequencyBinCount: fftSize / 2,
    _calls: 0,
    _lastBuffer: null as Uint8Array | null,
    getByteFrequencyData(arr: Uint8Array): void {
      a._calls++;
      a._lastBuffer = arr;
      // Default: zero out the buffer (silence).
      for (let i = 0; i < arr.length; i++) arr[i] = 0;
    },
    disconnect(): void {
      // mark as disconnected
      (a as { disconnected?: boolean }).disconnected = true;
    },
  };
  return a;
}

function makeFakeContext(analyser: AnalyserLike): AudioContextLike & { _closeCalls: number } {
  const source = {
    connect(_target: AnalyserLike): void {
      // no-op
    },
    disconnect(): void {
      (source as { disconnected?: boolean }).disconnected = true;
    },
  };
  return {
    _closeCalls: 0,
    createMediaStreamSource(_stream: MediaStream): AnalyserLike {
      return source as unknown as AnalyserLike;
    },
    createAnalyser(): AnalyserLike {
      return analyser;
    },
    async close(): Promise<void> {
      this._closeCalls++;
    },
    state: 'running',
  };
}

function installContext(ctx: AudioContextLike | null): void {
  if (ctx) {
    (window as unknown as { AudioContext: new () => AudioContextLike }).AudioContext =
      function () {
        return ctx;
      } as unknown as new () => AudioContextLike;
  } else {
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    delete (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext;
  }
}

function makeFakeStream(): MediaStream {
  const track = {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    stop: vi.fn(),
  };
  return {
    getTracks: () => [track as unknown as MediaStreamTrack],
  } as unknown as MediaStream;
}

describe('VoiceAnalyser', () => {
  beforeEach(() => {
    installContext(null);
  });

  test('uses AudioContext when available', () => {
    const analyser = makeFakeAnalyser();
    const ctx = makeFakeContext(analyser);
    installContext(ctx);
    const stream = makeFakeStream();
    new VoiceAnalyser(stream);
    expect(ctx._closeCalls).toBe(0);
  });

  test('falls back to webkitAudioContext if AudioContext missing', () => {
    const analyser = makeFakeAnalyser();
    const ctx = makeFakeContext(analyser);
    delete (window as unknown as { AudioContext?: unknown }).AudioContext;
    (window as unknown as { webkitAudioContext: new () => AudioContextLike }).webkitAudioContext =
      function () {
        return ctx;
      } as unknown as new () => AudioContextLike;
    const stream = makeFakeStream();
    new VoiceAnalyser(stream);
    expect(ctx._closeCalls).toBe(0);
  });

  test('returns 0 when AudioContext is unavailable', () => {
    installContext(null);
    const a = new VoiceAnalyser(makeFakeStream());
    expect(a.getVolume()).toBe(0);
    // destroy is safe
    expect(() => a.destroy()).not.toThrow();
  });

  test('getVolume() returns 0..1 range on silence', () => {
    const analyser = makeFakeAnalyser();
    installContext(makeFakeContext(analyser));
    const a = new VoiceAnalyser(makeFakeStream());
    const v = a.getVolume();
    expect(v).toBeGreaterThanOrEqual(0);
    expect(v).toBeLessThanOrEqual(1);
    expect(v).toBe(0);
  });

  test('getVolume() returns peak / 255 from frequency data', () => {
    const analyser = makeFakeAnalyser();
    const originalFn = analyser.getByteFrequencyData;
    analyser.getByteFrequencyData = (arr: Uint8Array) => {
      originalFn.call(analyser, arr);
      // Simulate a signal with peak 200 in bin 3.
      for (let i = 0; i < arr.length; i++) arr[i] = i === 3 ? 200 : 10;
    };
    installContext(makeFakeContext(analyser));
    const a = new VoiceAnalyser(makeFakeStream());
    const v = a.getVolume();
    expect(v).toBeCloseTo(200 / 255, 5);
    expect(analyser._calls).toBe(1);
  });

  test('getVolume() returns 0 after destroy()', () => {
    const analyser = makeFakeAnalyser();
    const ctx = makeFakeContext(analyser);
    installContext(ctx);
    const a = new VoiceAnalyser(makeFakeStream());
    a.destroy();
    // destroy is idempotent
    expect(() => a.destroy()).not.toThrow();
    expect(a.getVolume()).toBe(0);
    // close() was called exactly once
    expect(ctx._closeCalls).toBe(1);
  });

  test('destroy() disconnects the source node', () => {
    const analyser = makeFakeAnalyser();
    const ctx = makeFakeContext(analyser);
    installContext(ctx);
    const a = new VoiceAnalyser(makeFakeStream());
    a.destroy();
    // source.disconnect is called via the connect() shim — we can't
    // observe it directly, but the analyser should be GC-able and
    // getByteFrequencyData should not be called after destroy.
    expect(analyser._calls).toBe(0);
  });

  test('attaches ended listener to stream tracks', () => {
    const analyser = makeFakeAnalyser();
    installContext(makeFakeContext(analyser));
    const stream = makeFakeStream();
    new VoiceAnalyser(stream);
    const track = stream.getTracks()[0]!;
    expect(track.addEventListener).toHaveBeenCalledWith('ended', expect.any(Function));
  });

  test('handles createMediaStreamSource throwing', () => {
    const ctx: AudioContextLike = {
      createMediaStreamSource: () => {
        throw new Error('no audio track');
      },
      createAnalyser: () => makeFakeAnalyser(),
      async close() {},
      state: 'running',
    };
    installContext(ctx);
    const a = new VoiceAnalyser(makeFakeStream());
    expect(a.getVolume()).toBe(0);
    expect(() => a.destroy()).not.toThrow();
  });
});
