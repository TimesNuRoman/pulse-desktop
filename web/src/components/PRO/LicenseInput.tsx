// SPDX-License-Identifier: Apache-2.0
// Pulse — license key input (R119 PRO foundation).
//
// 5-group paste UI. Auto-uppercase, validates on blur, blocks submit on
// invalid format. Calls back with the normalized key on submit.

import { useState, useEffect, FormEvent, KeyboardEvent, ClipboardEvent } from 'react';
import { validateKey, normalizeKey, groupKey, TEST_KEY } from '../../lib/license/validate';

interface LicenseInputProps {
  /** Called with the raw, normalized key when the user submits a valid one. */
  onSubmit: (key: string) => void | Promise<void>;
  /** Disable the input + button (e.g. while writing to disk). */
  disabled?: boolean;
  /** External error message to surface (e.g. "activation failed"). */
  externalError?: string | null;
  /** Optional pre-fill value (used by the dev "Use test key" shortcut). */
  initialValue?: string;
}

const INPUT_PATTERN = '[A-Z2-9]';

function ChunkInput({
  value,
  onChange,
  onAdvance,
  onBack,
  index,
}: {
  value: string;
  onChange: (v: string) => void;
  onAdvance: () => void;
  onBack: () => void;
  index: number;
}) {
  function handleChange(v: string) {
    const upper = v.toUpperCase().replace(/[^A-HJ-KM-NP-Z2-9]/g, '').slice(0, 4);
    onChange(upper);
    if (upper.length === 4) onAdvance();
  }
  return (
    <input
      type="text"
      className="license-input__chunk"
      maxLength={4}
      value={value}
      onChange={(e) => handleChange(e.target.value)}
      onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Backspace' && !value && index > 0) onBack();
      }}
      autoCapitalize="characters"
      autoComplete="off"
      autoCorrect="off"
      spellCheck={false}
      pattern={INPUT_PATTERN}
    />
  );
}

export function LicenseInput({
  onSubmit,
  disabled,
  externalError,
  initialValue,
}: LicenseInputProps) {
  const [chunks, setChunks] = useState<string[]>(() => {
    const init = initialValue ? normalizeKey(initialValue) : TEST_KEY;
    const g = groupKey(init);
    return g.length === 6 ? g.slice(1) : ['', '', '', '', ''];
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (externalError) setError(externalError);
  }, [externalError]);

  function setChunk(i: number, v: string) {
    setChunks((prev) => prev.map((p, idx) => (idx === i ? v : p)));
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (disabled || submitting) return;
    const joined = `PULSE-${chunks.join('-')}`;
    const v = validateKey(joined);
    if (!v.valid) {
      setError(v.error ?? 'Invalid key');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      await onSubmit(joined);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  function handlePaste(e: ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData('text');
    if (!text) return;
    e.preventDefault();
    const normalized = normalizeKey(text);
    const g = groupKey(normalized);
    if (g.length === 6) {
      setChunks(g.slice(1));
    } else {
      // Best-effort: stuff whatever we got into the first chunk.
      const cleaned = normalized.replace(/[^A-HJ-KM-NP-Z2-9]/g, '').slice(0, 4);
      setChunk(0, cleaned);
    }
  }

  return (
    <form className="license-input" onSubmit={handleSubmit}>
      <div className="license-input__row">
        <span className="license-input__prefix">PULSE-</span>
        {chunks.map((c, i) => (
          <ChunkInput
            key={i}
            index={i}
            value={c}
            onChange={(v) => setChunk(i, v)}
            onAdvance={() => {
              if (i < 4) {
                const next = document.querySelectorAll<HTMLInputElement>(
                  '.license-input__chunk',
                )[i + 1];
                next?.focus();
              }
            }}
            onBack={() => {
              const prev = document.querySelectorAll<HTMLInputElement>(
                '.license-input__chunk',
              )[i - 1];
              prev?.focus();
            }}
          />
        ))}
        {/* Hidden paste-catcher to intercept full-key paste on the row. */}
        <input
          type="text"
          className="license-input__paste"
          onPaste={handlePaste}
          aria-hidden
          tabIndex={-1}
        />
      </div>
      {error && <div className="license-input__error">{error}</div>}
      <div className="license-input__actions">
        <button
          type="submit"
          className="license-input__submit"
          disabled={disabled || submitting || chunks.some((c) => c.length < 4)}
        >
          {submitting ? 'Activating...' : 'Activate'}
        </button>
      </div>
    </form>
  );
}
