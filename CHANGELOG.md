# Pulse Desktop — Changelog

## 0.6.8 — PRO license support (R127 / 2026-08-02)

Merges R119 (PRO license foundation) and R125 (LicenseInput activation fix) into
`main` and ships the first cut of Pulse PRO.

### R119 — PRO license foundation
- `src-tauri/src/license.rs` (267 lines) — Rust-side license module: format
  validation, test-key recognition, `license_ping` IPC command (stub
  verification, format-valid keys accepted; production Polar.sh endpoint
  deferred to a later round).
- `web/src/lib/license/types.ts` + `crypto.ts` + `store.ts` + `validate.ts`
  (569 lines) — TypeScript license layer: typed `License` model, WebCrypto
  helpers, Zustand-style persistent store, format+normalize helpers.
- `web/src/lib/pro-features.ts` (71 lines) — feature-flag layer exposing
  `isPro` selector and PRO-only capability checks.
- `web/src/lib/code-intel/parser.ts` (121 lines) — code-aware helpers used
  by PRO features.
- `web/src/components/PRO/LicenseInput.tsx` (208 lines) — paste-and-activate
  license input with format validation + error surface.
- `web/src/components/PRO/PROBadge.tsx` (29 lines) — header badge that
  shows Free / PRO state.
- `web/src/components/PRO/UpgradeModal.tsx` (93 lines) — full-screen PRO
  upgrade flow with the soft-sell copy from Pulse UI rules.
- `web/src/components/settings/PROSettings.tsx` (122 lines) — Settings →
  PRO pane: paste key, see status, sign out.
- 4 PRO feature gates wired into the existing app: multi-model routing,
  code-intel (parser), voice STT, web search priority.
- Voice STT (`web/src/voice/stt.ts`): PRO-only Web Speech recognition path.
- HabrSearch (`web/src/components/HabrSearch.tsx`): PRO priority flag in
  search options.
- `web/src/components/SettingsView.tsx` + `web/src/App.tsx`: PRO entry
  points and integration glue.
- `web/src/styles.css` (+323 lines) — PRO UI styles (Tokyo Night palette,
  dark only).
- 31 new tests:
  - `web/src/lib/license/__tests__/crypto.test.ts` (4)
  - `web/src/lib/license/__tests__/store.test.ts` (5)
  - `web/src/lib/license/__tests__/validate.test.ts` (12)
  - 10 inline `license::tests::*` in `src-tauri/src/license.rs`
  - vitest LicenseInput coverage (8) plus Rust `is_test_key` /
    `is_valid_key_format` / `license_ping` / `normalize_key` (8)

### R125 — LicenseInput activation fix
- Removes prefill of test key from the LicenseInput on first render
  (regression in R119 where the field was auto-populated, hiding whether
  the user's input actually fires the activation handler).
- Adds a dev-only "Use test key" button (gated on `import.meta.env.DEV`)
  that fills the canonical test key into the input, so dev/QA can
  exercise the activation flow without typing the long key.
- 8 new vitest cases in
  `web/src/components/PRO/__tests__/LicenseInput.test.tsx`
  (190 lines) — covers paste validation, format rejection, dev-button
  presence (dev only), and the activation handler.

### Test totals
- vitest: **47/47** (5 files)
- cargo test --lib: **76/76**
- `tsc --noEmit`: **0 errors**

### Installers (Windows x64, unsigned)
- `Pulse Notes_0.6.8_x64-setup.exe` (NSIS, ~12 MB)
- `Pulse Notes_0.6.8_x64_en-US.msi` (MSI, ~17 MB)
- `pulse-desktop.exe` (release, ~10 MB)

Signing / notarization deferred. Public Polar.sh PRO server deferred
(R128+). Anonymous distribution motion only — no "by Roman" anywhere.

---

## 0.6.4 — R91 release (2026-07-30)

R82 tree-sitter code-aware Smart Engine v3 routing + R89 low_confidence UI
consumer + 85 tests. See `d8c6a4e` for the full commit list.

## 0.6.0 — Smart Engine v3 (R79)

Phase 3 default ON, `PassThreshold=5`, marker expansion, IPC commands.
See `366e940` and `7159060`.
