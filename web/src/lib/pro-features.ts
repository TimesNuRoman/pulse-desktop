// SPDX-License-Identifier: Apache-2.0
// Pulse — PRO feature catalog (R119 PRO foundation).
//
// Each feature has:
//   * key     — ProFeature enum value
//   * label   — short user-facing name (no emoji, no "revolutionary")
//   * hint    — one-sentence explainer for the upgrade modal
//   * gate    — how to enforce (`async` = use requirePro in caller;
//               `sync`  = use isPro() in render path)
//   * fallback — what FREE users get instead of this feature
//
// Architecture (PULSE-PRO-ARCHITECTURE-2026-08-02.md §3.1):
//   v0.6.7 gates: multi-model, code-intel, voice-input, web-search.
//   v0.8.0 gates: settings-sync, priority-updates.

import type { ProFeature } from './license/types';

export interface ProFeatureInfo {
  key: ProFeature;
  label: string;
  hint: string;
  /** `async` → throw ProRequiredError; `sync` → use isPro() at render. */
  gate: 'async' | 'sync';
  /** What FREE users get instead. Honest fallback, not a paywall taunt. */
  fallback: string;
}

export const PRO_FEATURES: Record<ProFeature, ProFeatureInfo> = {
  'multi-model': {
    key: 'multi-model',
    label: 'Multi-model hot-swap',
    hint: 'Switch between several installed LLMs without restarting chat.',
    gate: 'async',
    fallback: 'Single active model from Settings.',
  },
  'code-intel': {
    key: 'code-intel',
    label: 'Code intelligence',
    hint: 'Tree-sitter symbol extraction, cross-file references, semantic search.',
    gate: 'async',
    fallback: 'Plain text chat (no code-aware features).',
  },
  'voice-input': {
    key: 'voice-input',
    label: 'Whisper voice input',
    hint: 'Local Whisper STT for accurate offline transcription.',
    gate: 'async',
    fallback: 'OS SpeechRecognition (browser-native, language-limited).',
  },
  'web-search': {
    key: 'web-search',
    label: 'Web search',
    hint: 'Habr and YouTube search inside the panel.',
    gate: 'async',
    fallback: 'No web search in panel.',
  },
  'settings-sync': {
    key: 'settings-sync',
    label: 'Settings sync',
    hint: 'Sync settings across devices with end-to-end encryption.',
    gate: 'async',
    fallback: 'Local settings only.',
  },
  'priority-updates': {
    key: 'priority-updates',
    label: 'Priority updates',
    hint: 'Early access to new builds before the stable channel.',
    gate: 'async',
    fallback: 'Stable channel only.',
  },
};
