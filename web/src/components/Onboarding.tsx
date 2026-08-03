// SPDX-License-Identifier: Apache-2.0
// Pulse desktop — first-run onboarding tour (R161).
//
// Shown once after first install + launch on Windows desktop. 3-step tour
// explains the value, points at the model picker, and ends with a chat
// prompt. Persisted in localStorage so it never nags again after completion.
//
// Key: `pulse.onboarding.completed.v1` (versioned for future schema bumps).
// Mobile (Capacitor) has its own onboarding under `mobile/Onboarding.tsx`
// with a different key — desktop and mobile are independent surfaces.
//
// a11y: role="dialog" + aria-modal="true" + aria-labelledby, Escape closes,
// Tab is trapped inside the modal while open. 56dp min-height on every
// button (touch-friendly on tablets / large screens).

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';

const LS_DONE = 'pulse.onboarding.completed.v1';
const LS_DONE_TS = 'pulse.onboarding.completed.v1.ts';

export function isOnboardingDone(): boolean {
  try {
    return localStorage.getItem(LS_DONE) === 'true';
  } catch {
    return false;
  }
}

export function markOnboardingDone(): void {
  try {
    localStorage.setItem(LS_DONE, 'true');
    localStorage.setItem(LS_DONE_TS, String(Date.now()));
  } catch {
    /* localStorage may be disabled — ignore */
  }
}

export function resetOnboarding(): void {
  try {
    localStorage.removeItem(LS_DONE);
    localStorage.removeItem(LS_DONE_TS);
  } catch {
    /* ignore */
  }
}

export type OllamaStatus = 'pending' | 'ok' | 'err';

export interface OnboardingProps {
  /** Called when the user finishes, skips, or presses Escape. */
  onDone: () => void;
  /** Optional: open the Settings view from step 2 (parent decides routing). */
  onOpenSettings?: () => void;
  /** Currently active LLM model name (e.g. "gemma2:2b"). Empty = none. */
  currentModel?: string;
  /** Ollama sidecar status. "ok" = ready, "err" = not reachable, "pending" = checking. */
  ollamaStatus?: OllamaStatus;
}

interface Step {
  title: string;
  body: React.ReactNode;
}

function buildSteps(currentModel: string, ollamaStatus: OllamaStatus): Step[] {
  const hasModel = currentModel.trim().length > 0;
  return [
    {
      title: 'Local AI in your side panel',
      body: (
        <>
          <p className="onb-desk__lede">
            Pulse is a local-first assistant for notes, chat, and quick
            search. It runs on this machine, not in the cloud.
          </p>
          <ul className="onb-desk__bullets">
            <li>Runs on your machine. No cloud, no telemetry.</li>
            <li>Voice + keyboard, notes + chat in one place.</li>
            <li>PRO adds multi-model hot-swap and code-aware chat.</li>
          </ul>
        </>
      ),
    },
    {
      title: 'Pick your model',
      body: hasModel && ollamaStatus === 'ok' ? (
        <>
          <p className="onb-desk__lede">
            Current model: <code>{currentModel}</code>. Ollama is running.
          </p>
          <p className="onb-desk__lede">
            Change it any time in <b>Settings → AI Models</b>.
          </p>
        </>
      ) : (
        <>
          <p className="onb-desk__lede">
            {hasModel
              ? `Model is set to ${currentModel}, but Ollama is not reachable yet.`
              : 'No model is selected yet.'}
          </p>
          <p className="onb-desk__lede">
            Open Settings to pick a model, or run the Pulse Setup Wizard
            to download one automatically.
          </p>
        </>
      ),
    },
    {
      title: 'Start chatting',
      body: (
        <>
          <p className="onb-desk__lede">
            Press <code>Ctrl+K</code> to open Quick Switcher, or click the
            input below and type a message.
          </p>
          <p className="onb-desk__lede">
            Try: <i>Summarize my last note</i> or <i>What did I save on Monday?</i>
          </p>
        </>
      ),
    },
  ];
}

const FOCUSABLE_SELECTOR =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Onboarding({
  onDone,
  onOpenSettings,
  currentModel = '',
  ollamaStatus = 'pending',
}: OnboardingProps) {
  const steps = useMemo(
    () => buildSteps(currentModel, ollamaStatus),
    [currentModel, ollamaStatus],
  );
  const [step, setStep] = useState(0);
  const isLast = step === steps.length - 1;
  const isFirst = step === 0;
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const lastFocusedRef = useRef<HTMLElement | null>(null);

  const finish = useCallback(() => {
    markOnboardingDone();
    onDone();
  }, [onDone]);

  const goNext = useCallback(() => {
    if (isLast) {
      finish();
    } else {
      setStep((s) => Math.min(s + 1, steps.length - 1));
    }
  }, [isLast, finish, steps.length]);

  const goBack = useCallback(() => {
    setStep((s) => Math.max(s - 1, 0));
  }, []);

  // Focus trap + Escape handler. On mount: remember the previously focused
  // element, move focus into the modal. On unmount: restore focus.
  useEffect(() => {
    lastFocusedRef.current = document.activeElement as HTMLElement | null;
    // Defer focus to next tick so the modal is rendered.
    const focusTimer = window.setTimeout(() => {
      primaryRef.current?.focus();
    }, 0);

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish();
        return;
      }
      if (e.key !== 'Tab') return;
      const root = dialogRef.current;
      if (!root) return;
      const focusables = Array.from(
        root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => !el.hasAttribute('disabled') && el.offsetParent !== null);
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (active === first || !root.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (active === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', onKeyDown);
      lastFocusedRef.current?.focus?.();
    };
  }, [finish]);

  const cur = steps[step]!;

  return (
    <div
      ref={dialogRef}
      className="onb-desk"
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      data-testid="onb-desk-modal"
    >
      <div className="onb-desk__card">
        <div className="onb-desk__counter" aria-live="polite">
          Step {step + 1} of {steps.length}
        </div>
        <h2 id={titleId} className="onb-desk__title">
          {cur.title}
        </h2>
        <div className="onb-desk__body">{cur.body}</div>

        {step === 1 && ollamaStatus !== 'ok' && (
          <button
            type="button"
            className="onb-desk__btn onb-desk__btn--primary onb-desk__btn--cta"
            onClick={() => {
              if (onOpenSettings) {
                onOpenSettings();
              } else {
                finish();
              }
            }}
          >
            Run Pulse Setup Wizard
          </button>
        )}

        <div className="onb-desk__dots" aria-hidden>
          {steps.map((_, i) => (
            <span
              key={i}
              className={`onb-desk__dot${i === step ? ' is-active' : ''}`}
            />
          ))}
        </div>

        <div className="onb-desk__nav">
          {isFirst ? (
            <button
              type="button"
              className="onb-desk__btn onb-desk__btn--ghost"
              onClick={finish}
              data-testid="onb-desk-skip"
            >
              Skip
            </button>
          ) : (
            <button
              type="button"
              className="onb-desk__btn onb-desk__btn--ghost"
              onClick={goBack}
              data-testid="onb-desk-back"
            >
              Back
            </button>
          )}
          <button
            ref={primaryRef}
            type="button"
            className="onb-desk__btn onb-desk__btn--primary"
            onClick={goNext}
            data-testid="onb-desk-next"
            autoFocus
          >
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
}
