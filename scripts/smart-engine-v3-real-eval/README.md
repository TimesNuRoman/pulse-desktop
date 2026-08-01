# Smart Engine v3 — Real-User Eval Harness (R79)

**Cycle:** R79 (post-Phase 3, PassThreshold 12 → 8)
**Date:** 2026-08-01
**Goal:** Validate the R75 finding (+32pp pass rate, −1370ms p50) on **real** user prompts, not synthetic.

## What is this

A PowerShell 7 harness that runs 100 real-user-flavored prompts through Smart Engine v3's routing logic and (when IPC is available) the actual LLM, then scores results against a category-specific rubric.

The R75 A/B harness used **50 synthetic tasks** with hand-curated `v3Resp` / `baseResp` (best-case test of routing). This harness uses **100 real-user-flavored prompts** with no curated responses — what the user actually typed. It measures routing accuracy (Tier A) and response quality (Tier B, when IPC works).

## Files

```
scripts/smart-engine-v3-real-eval/
├── prompts.jsonl       # 100 real-user prompts, 4 categories × 25
├── scoring-rubric.md   # Tier A (routing) + Tier B (response) scoring rules
├── run-eval.ps1        # PowerShell 7 harness
└── README.md           # this file
```

## Prompt categories

| Category | Count | Example | Expected engine mode |
|---|---:|---|---|
| `habr-search` | 25 | "Найди статьи на Хабре про async/await в Rust последние два года" | `default` (no flip) |
| `code-edit` | 25 | "Переименуй функцию `calculate_total` в `compute_subtotal`" | `code` (flip) |
| `quick-answer` | 25 | "Какой синтаксис для деструктуризации объекта в TypeScript?" | `default` or `fast` |
| `tool-call-pattern` | 25 | "Найди все .rs файлы в папке src больше 1000 строк" | `default` (tool-call doesn't flip) |

All prompts are Russian (matching the actual user base) and avoid the 50 R75 synthetic prompts.

## Modes

### `--simulate` (works now, no Pulse required)

Mirrors the Smart Engine v3 logic in PowerShell, scores **routing decisions only** (Tier A). This is honest evaluation of the routing algorithm on real prompts — no fake LLM responses.

```powershell
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 `
    -Mode simulate `
    -EngineMode v3-on `
    -Limit 5
```

Output:
- `data/eval-results-simulate-v3-on-YYYYMMDD-HHMMSS.jsonl` (5 entries, 1 per prompt)
- `data/eval-summary-simulate-v3-on-YYYYMMDD-HHMMSS.json` (aggregate)

### `--invoke` (requires R79 IPC)

Calls Pulse through Tauri IPC, captures the actual LLM response, scores Tier A (routing) + Tier B (response). **Requires R79 build with IPC commands `engine_decide` and `engine_invoke`** — these are not yet implemented.

```powershell
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 `
    -Mode invoke `
    -BuildPath "C:\Users\1\.minimax\workspace\downloads\Pulse-0.6.0-portable\Pulse.exe" `
    -EngineMode v3-on
```

If IPC is not available, the harness falls back to **soft-fail** — Tier A scoring still runs, Tier B is recorded as `IPC_NOT_AVAILABLE` with a clear error. This way you can see the routing decision even when end-to-end isn't ready.

## Engine modes

| `-EngineMode` | PassThreshold | Behavior |
|---|---|---|
| `baseline` | 99 | Smart Engine disabled, all prompts use `default` gemma3:4b |
| `v3-off` | 99 | Smart Engine enabled, but threshold too high to ever flip |
| `v3-on` | 8 | R79 default — relaxed threshold, should fire on code-edit prompts |

Run all three on the same 100 prompts and compare pass rates / latency to confirm R75's +32pp finding holds on real traffic.

## Quick start (now)

```powershell
# 1. Pilot dry-run on 5 prompts (no disk writes)
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -DryRun -Limit 5

# 2. Full simulate run, all 100 prompts, v3-on
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -EngineMode v3-on

# 3. Compare to baseline (no flips)
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -EngineMode baseline

# 4. Compare to v3-off (Smart Engine on, but threshold high)
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 -Mode simulate -EngineMode v3-off
```

Compare the three summary.json files to see routing behavior across modes.

## When R79 ships

```powershell
# 5. E2E invoke on R79 build (after Coder agent adds IPC)
pwsh -File scripts/smart-engine-v3-real-eval/run-eval.ps1 `
    -Mode invoke `
    -BuildPath "C:\Users\1\.minimax\workspace\downloads\Pulse-0.6.0-portable\Pulse.exe" `
    -EngineMode v3-on

# 6. Compare against R75's +32pp finding
# Open both summary.json files, look at tier_a_routing_pass_rate and tier_b_response_pass_rate
```

## Expected results (hypothesis)

Based on R75 synthetic data + R79 threshold relaxation:

| Metric | baseline | v3-off | v3-on |
|---|---:|---:|---:|
| Tier A routing pass | 70% (no flips) | 70% (threshold too high) | **90%+** (flips where they help) |
| Tier B response pass (invoke) | 60% | 62% | **85-92%** (matches R75) |
| Flipped count (v3-on) | 0 | 0 | **10-15** (out of 100) |
| Latency p50 (invoke) | ~1600ms | ~1500ms | **~300ms** (matches R75) |

If actual results match the prediction → ship v3 default ON. If `tier_a_routing_pass < 80%` → investigate marker set or category mapping. If `tier_b_response_pass < 70%` with v3-on → routing picked wrong model, check `preferred_model` distribution.

## Gap: IPC not yet implemented

R78 doesn't have a Tauri command for `auto_prefer` — the engine module is pure-Rust internal, never called via IPC. The harness has an `Invoke-PulseEngine` stub that returns `IPC_NOT_AVAILABLE` with a clear error.

**For R79 to enable `--invoke` mode**, the Coder agent needs to add in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
async fn engine_decide(
    user_text: String,
    category: Option<String>,
) -> Result<engine::EngineDecision, String> {
    let cat = category.and_then(|c| match c.as_str() {
        "code-edit" => Some(engine::TaskCategory::CodeEdit),
        "reasoning" => Some(engine::TaskCategory::Reasoning),
        "chat" => Some(engine::TaskCategory::Chat),
        "tool-use" => Some(engine::TaskCategory::ToolUse),
        _ => None,
    });
    let features = engine::smart_engine::extract_features(&user_text, false, cat);
    let input = engine::TaskInput { user_text, features };
    Ok(engine::auto_prefer(&input, "gemma3:4b"))
}

#[tauri::command]
async fn engine_invoke(
    user_text: String,
    category: Option<String>,
    mode: String,  // "baseline" | "v3-off" | "v3-on"
) -> Result<EngineInvokeResult, String> {
    // 1. Decide model via auto_prefer (if mode is "v3-on" / "v3-off")
    // 2. Build Ollama request with decided model
    // 3. Stream response back
    // 4. Log to AbLogWriter
    // ...
}
```

Plus registration in `tauri::generate_handler!` block. Total scope: ~80 lines of Rust.

Once R79 ships with these commands, the harness `--invoke` mode will work end-to-end. Until then, `--simulate` is the recommended path.

## Rubric details

See `scoring-rubric.md` for the full Tier A / Tier B / Tier C breakdown, including:
- Routing expectation table per category
- Per-condition hit-rate targets
- Per-category pass criteria
- Output JSON schema
- What this rubric does NOT measure (multilingual, multi-turn, vision)

## See also

- `H:\Вайбкодинг\research\SMART-ENGINE-V3-AB-RESULT-2026-08-01.md` — R75 report (synthetic A/B, +32pp finding)
- `src-tauri/src/engine/` — Smart Engine v3 source (mirror logic)
- `scripts/verify-smart-engine-v3.ps1` — R75 harness (synthetic, this one's R79 counterpart)
