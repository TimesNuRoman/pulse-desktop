// SPDX-License-Identifier: Apache-2.0
// R188: Voice input button (port of pulse-android R172).
//
// Click to start recording, click again to stop. While recording the
// button turns red and a small inline waveform + duration counter
// appear next to it. On stop the audio blob is captured locally and
// a placeholder text is emitted via `onTranscript` — the real STT
// pipeline (Whisper.cpp) is a R189+ follow-up.
//
// The button keeps the same DOM signature as the previous mic button
// (`chat__iconbtn chat__iconbtn--mic`) so the existing form layout and
// recording-state CSS still work. We render an inline SVG mic icon
// instead of an emoji to keep the brief's no-emoji rule for new files.

import { useCallback, useEffect, useRef, useState } from 'react';
import { VoiceRecorder, type VoiceState } from '../lib/voiceRecorder';

export interface VoiceButtonProps {
  /** Called with a placeholder text when the user stops recording. */
  onTranscript: (text: string) => void;
  /** Called when recording fails (permission denied, no mic, etc). */
  onError?: (error: Error) => void;
  /** Called whenever the recording state flips. Lets the parent
   *  (ChatView) toggle its own input placeholder/disabled state without
   *  the button having to lift state up. */
  onRecordingChange?: (recording: boolean) => void;
  /** Disables the button. */
  disabled?: boolean;
  /** Placeholder text inserted into the input. Defaults to "voice memo recorded, transcript pending". */
  placeholderText?: string;
}

/**
 * Renders N small bars that scale vertically based on the current mic
 * volume. Pure CSS — no canvas, no SVG per-bar.
 */
function InlineWaveform({ volume }: { volume: number }): JSX.Element {
  const BARS = 5;
  const safe = Math.max(0, Math.min(1, volume));
  const scale = 0.2 + safe * 0.8;
  const phases = Array.from({ length: BARS }, (_, i) => (i / BARS) * 0.5);
  return (
    <div
      className="voice-waveform"
      role="img"
      aria-label="Recording volume"
      data-testid="voice-waveform"
    >
      {phases.map((phase, i) => (
        <span
          key={i}
          className="voice-waveform__bar"
          style={{
            ['--vw-scale' as string]: String(scale),
            ['--vw-delay' as string]: `${phase}s`,
          }}
          data-testid={`voice-waveform-bar-${i}`}
        />
      ))}
    </div>
  );
}

function formatDuration(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

const DEFAULT_PLACEHOLDER = '[voice memo recorded, transcript pending]';

export function VoiceButton({
  onTranscript,
  onError,
  onRecordingChange,
  disabled = false,
  placeholderText = DEFAULT_PLACEHOLDER,
}: VoiceButtonProps): JSX.Element {
  const [state, setState] = useState<VoiceState>('idle');
  const [volume, setVolume] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [recordingMs, setRecordingMs] = useState(0);
  const recorderRef = useRef<VoiceRecorder | null>(null);
  const startedAtRef = useRef<number>(0);
  const tickRef = useRef<number | null>(null);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      recorderRef.current?.destroy();
      recorderRef.current = null;
      if (tickRef.current != null) {
        window.clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };
  }, []);

  // Clear the inline error chip after a few seconds so it doesn't stick.
  useEffect(() => {
    if (!errorMessage) return;
    const id = window.setTimeout(() => setErrorMessage(null), 4000);
    return () => window.clearTimeout(id);
  }, [errorMessage]);

  const handleStateChange = useCallback((next: VoiceState) => {
    setState(next);
    onRecordingChange?.(next === 'recording' || next === 'stopping');
  }, [onRecordingChange]);

  const handleVolume = useCallback((v: number) => {
    setVolume(v);
  }, []);

  const handleError = useCallback(
    (err: Error) => {
      const code = (err as { code?: string }).code;
      let msg: string;
      switch (code) {
        case 'permission-denied':
          msg = 'Microphone permission denied.';
          break;
        case 'no-microphone':
          msg = 'No microphone found.';
          break;
        case 'not-supported':
          msg = 'Voice input is not supported in this environment.';
          break;
        case 'recording-failed':
        default:
          msg = err.message || 'Voice recording failed.';
      }
      setErrorMessage(msg);
      onError?.(err);
    },
    [onError]
  );

  const startTimer = useCallback(() => {
    startedAtRef.current = Date.now();
    setRecordingMs(0);
    if (typeof window === 'undefined') return;
    tickRef.current = window.setInterval(() => {
      setRecordingMs(Date.now() - startedAtRef.current);
    }, 250);
  }, []);

  const stopTimer = useCallback(() => {
    if (tickRef.current != null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    setRecordingMs(0);
    setVolume(0);
  }, []);

  const startRecording = useCallback(async () => {
    setErrorMessage(null);
    if (recorderRef.current) recorderRef.current.destroy();
    const rec = new VoiceRecorder({
      onStateChange: handleStateChange,
      onVolume: handleVolume,
      onError: handleError,
    });
    recorderRef.current = rec;
    try {
      await rec.start();
      startTimer();
    } catch {
      // error already pushed via onError
      stopTimer();
      rec.destroy();
      recorderRef.current = null;
    }
  }, [handleError, handleStateChange, handleVolume, startTimer, stopTimer]);

  const stopRecording = useCallback(async () => {
    const rec = recorderRef.current;
    if (!rec) return;
    try {
      await rec.stop();
      // Blob is captured but not consumed in v1 (no STT). Future R-rounds
      // can hook the blob to a Whisper.cpp pipeline.
      onTranscript(placeholderText);
    } catch {
      // error already pushed via onError
    } finally {
      stopTimer();
      rec.destroy();
      recorderRef.current = null;
    }
  }, [onTranscript, placeholderText, stopTimer]);

  const onClick = useCallback(() => {
    if (disabled) return;
    if (state === 'recording' || state === 'stopping') {
      void stopRecording();
    } else {
      void startRecording();
    }
  }, [disabled, startRecording, state, stopRecording]);

  // Esc cancels an in-flight recording.
  useEffect(() => {
    if (state !== 'recording' && state !== 'stopping') return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      const rec = recorderRef.current;
      if (rec) {
        rec.destroy();
        recorderRef.current = null;
        stopTimer();
        setErrorMessage('Recording cancelled.');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, stopTimer]);

  const isRecording = state === 'recording' || state === 'stopping';
  const buttonClass = `chat__iconbtn chat__iconbtn--mic${isRecording ? ' is-rec' : ''}`;

  return (
    <span className="voice-button-wrap" data-testid="voice-button-wrap" data-state={state}>
      <button
        type="button"
        className={buttonClass}
        onClick={onClick}
        disabled={disabled}
        title={
          isRecording
            ? 'Recording… (click or Esc to stop)'
            : 'Voice input (click to record, click again to insert)'
        }
        aria-label={isRecording ? 'Stop voice recording' : 'Start voice recording'}
        aria-pressed={isRecording}
        data-testid="voice-button"
      >
        {/* Inline mic SVG (no emoji per brief rule #7). 16x16 fits the
            28x28 button on desktop, 44x44 on touch (no resize needed). */}
        <svg
          className="voice-button__icon"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
          <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
          <line x1="12" y1="19" x2="12" y2="23" />
          <line x1="8" y1="23" x2="16" y2="23" />
        </svg>
      </button>
      {isRecording && (
        <>
          <InlineWaveform volume={volume} />
          <span className="voice-button__duration" data-testid="voice-duration">
            {formatDuration(recordingMs)}
          </span>
        </>
      )}
      {errorMessage && !isRecording && (
        <span className="voice-button__error" role="alert" data-testid="voice-error">
          {errorMessage}
        </span>
      )}
    </span>
  );
}
