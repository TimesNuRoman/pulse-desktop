# Smart Engine v3 — Real-User Eval Scoring Rubric (R79)

**Cycle:** R79 (post-Phase 3, threshold relaxed 12 → 8)
**Eval set:** 100 real-user-flavored prompts, 4 categories × 25
**Date:** 2026-08-01
**Status:** Draft v1 — applies to **invoke mode** end-to-end. **Simulate mode** uses a strict subset (routing-only).

---

## 0. Two scoring tiers

The harness supports two evaluation modes with different scoring depth:

| Mode | What it scores | When it works |
|---|---|---|
| `--simulate` | **Routing decision only** (would it flip? preferred model? conditions fired?) | Now (no IPC required) |
| `--invoke` | **Full E2E** (routing + actual LLM response + latency) | After R79 ships an IPC command for `auto_prefer` |

The rubric below is split into Tier A (works in simulate) and Tier B (requires invoke).

---

## Tier A — Routing decision scoring (works in `--simulate`)

For each prompt, the harness:
1. Extracts `EngineFeatures` (mirrors `extract_features()` in `src-tauri/src/engine/smart_engine.rs`)
2. Runs `auto_prefer()` logic (mirrored in PowerShell — see `run-eval.ps1`)
3. Compares the decision to `expected_mode` and category-driven expectations

### A.1 — Routing accuracy

**Score = 1.0 if `preferred_model` matches the category-driven expectation, 0.0 otherwise.**

| Category | Expected preferred model | Rationale |
|---|---|---|
| `habr-search` | `default` (does NOT flip to code/fast/large) | Habr queries are fact-retrieval; "code" model is overkill, "fast" loses quality, "large" is too slow. Default gemma3:4b is the right call. |
| `code-edit` | `code` (should flip) | Code tasks need the code-specialized model for accurate output. |
| `quick-answer` | `default` or `fast` (depends on length) | Quick answers benefit from the fast model; long explanations stay on default. |
| `tool-call-pattern` | `default` (tool-call is logged but does NOT flip) | Per design: tool-call pattern is about output format, not model capability. |

A `flipped=true` on `habr-search` or `tool-call-pattern` is a **routing regression** (Tier A score = 0).
A `flipped=false` on `code-edit` (when code markers present) is a **routing regression** (Tier A score = 0).

### A.2 — Condition hit-rate (per condition)

For each condition, count how many prompts fired it (out of 100, and per category).

Expected hit-rates for real-user prompts:

| Condition | Expected hit-rate | Why |
|---|---:|---|
| `vision` | 0% | Text-only test, no images. |
| `code-edit` | ~30% (30/100) | Fires on `code-edit` (25) + ~5 of `tool-call-pattern` (which mention code terms like `tauri::command`). Should NOT fire on `quick-answer` (no code blocks) or `habr-search` (no code blocks). |
| `short` | ~5% (5/100) | Most prompts are >60 chars. Short fires on terse `quick-answer` and `tool-call-pattern` like "Поставь громкость на 30%". |
| `long` | ~5% (5/100) | Most prompts <600 chars. Long fires on elaborate `habr-search` or `code-edit` requests. |
| `tool-call-pattern` | ~25% (25/100) | Should fire on all `tool-call-pattern` prompts. May also fire on JSON-looking `habr-search` with `?` and `&` URL params. |

A `code-edit` hit-rate < 25/25 (100%) on the `code-edit` category is a **marker-set gap** (Tier A score = 0 for those prompts).

### A.3 — Flipped-rate

`flipped` = score >= 8 (R79 threshold) AND preferred != fallback.

Expected for R79 (threshold=8):
- `code-edit` category: ~10-15 flips (those with code markers + length > 0 → 5+2=7 still no flip; with marker + length > 600 → 5+5+2=12 yes; with marker only → 5+2=7 no. Need at least one of: marker + long, or 2 conditions.)
- `quick-answer` category: ~0-2 flips (no code markers, mostly short — score is 2 or 7).
- `habr-search`: ~0 flips (no code markers, mixed length, score mostly 2-5).
- `tool-call-pattern`: ~0 flips (tool-call pattern doesn't add to score, only logs).

**Net expected flipped-rate: 10-15%** (10-15 prompts out of 100).

If R75's 0% flipped-rate doesn't improve to 10-15% with threshold=8, the recommendation to relax threshold failed.

---

## Tier B — LLM response scoring (works in `--invoke` only)

For each prompt, after the routing decision, the actual LLM response is scored against category-specific criteria.

### B.1 — `code-edit` category (25 prompts)

**Pass criteria (all must be true):**
1. Response contains a code block (```...``` fence) OR valid Rust/TS/Svelte code in plain text
2. Response applies to the file/snippet the user provided (or generates new code if no context was given)
3. The proposed change is **syntactically valid** (compiles or lints clean)
4. Response length: 50-1500 tokens (terse enough to be useful, verbose enough to be clear)

**Fail criteria:**
- Response starts with "Sure! Here's..." filler without actual code (R75 baseline failure pattern)
- Response is a question back to the user without attempting the edit
- Response contains hallucinated APIs (e.g., `serde::MagicalDeserialize`)
- Response is empty or just an error message

**Scoring per prompt:**
- `passed` (bool): all 4 pass criteria met
- `quality` (1-5): subjective — Roman's LLM-judge on a 1-5 scale
  - 5 = perfect, applies diff correctly, no extraneous changes
  - 4 = correct, minor style nit
  - 3 = works but verbose
  - 2 = partial fix
  - 1 = wrong or no code

### B.2 — `quick-answer` category (25 prompts)

**Pass criteria:**
1. Response is **factually correct** (verifiable answer, no hallucinations)
2. Response length: 30-500 tokens (terse but complete)
3. Response is **direct** — answers the question, doesn't hedge
4. Response addresses the specific question (not a generic "here's how to learn X")

**Scoring:**
- `passed` (bool): criteria 1, 2, 3 met
- `correct` (bool): criterion 1 specifically (factual accuracy)

### B.3 — `habr-search` category (25 prompts)

**Pass criteria (all must be true):**
1. Response contains **3+ relevant result items** (title + URL + snippet)
2. At least 1 result is from `habr.com` (Russian-language source)
3. Results are **topically relevant** to the query (Roman's relevance check)
4. Response does not invent fake URLs (e.g., `habr.com/post/999999-fake`)

**Scoring:**
- `passed` (bool): criteria 1-3 met
- `russian_source_count` (int): how many results are `habr.com` (target: >=1)
- `total_results` (int): how many results returned (target: >=3)
- `relevance_pct` (float, 0-1): Roman's judgment on what % of results are actually on-topic

### B.4 — `tool-call-pattern` category (25 prompts)

**Pass criteria (all must be true):**
1. Pulse invokes the **correct Tauri command** for the request (e.g., `search_files` for "find .rs files")
2. The command's **arguments** are correctly extracted from the prompt
3. The command's **result** is presented to the user (not just "executed")
4. If the command fails (file not found, network error), Pulse **handles the error gracefully**

**Scoring:**
- `passed` (bool): criteria 1-2 met
- `correct_command` (bool): criterion 1 specifically
- `args_extracted` (bool): criterion 2
- `error_handled` (bool): criterion 4 (only relevant if command fails)

---

## Tier C — Cross-cutting metrics (always computed)

### C.1 — Latency p50 / p95

For each mode (`baseline`, `v3-on`, `v3-off`):
- Compute p50 and p95 of `latency_ms` across all 100 prompts
- v3 should be ≥30% faster p50 than baseline (R75 finding: −1370ms p50, ~85% reduction)
- If v3 is NOT faster, the routing choice was wrong (selected large model when fast would do)

### C.2 — Routing distribution

Across 100 prompts, what % went to each model:
- `default`, `code`, `vision`, `fast`, `large`

Expected distribution (R79 with threshold=8):
- `default`: ~75% (no flip)
- `code`: ~15% (code-edit category where conditions met)
- `fast`: ~5% (short quick-answer / tool-call)
- `large`: ~5% (long habr-search with 2-condition flip)
- `vision`: 0%

### C.3 — Per-mode comparison

Three modes run on the same 100 prompts:
- `baseline`: Smart Engine disabled, all prompts go through default gemma3:4b
- `v3-on`: Smart Engine enabled with threshold=8 (R79 default)
- `v3-off`: Smart Engine enabled but PassThreshold set to 99 (effectively never flips)

The expected results matrix:

| Metric | baseline | v3-on | v3-off |
|---|---:|---:|---:|
| Pass rate (Tier B) | ~60% (R75 baseline) | **~88%** (predicted) | ~62% (similar to baseline) |
| Latency p50 | ~1600ms | **~300ms** | ~1500ms (close to baseline) |
| Flipped count | 0/100 (no routing) | **10-15/100** | 0/100 (threshold too high) |
| Default hit-rate | 100% | ~75% | 100% |

**Hypothesis (to confirm in R79 invoke run):** v3-on gives +28-32pp over baseline, comparable to R75's synthetic +32pp. If confirmed → ship v3 default ON permanently. If not → investigate why real traffic differs from synthetic.

---

## 4. Output schema

Each line in `eval-results-{ts}.jsonl`:

```json
{
  "ts": 1785560116844,
  "prompt_id": "real-001",
  "category": "habr-search",
  "mode": "v3-on",
  "prompt": "Найди статьи на Хабре про async/await в Rust последние два года",
  "response_excerpt": "...",
  "latency_ms": 230,
  "routing": {
    "preferred_model": "default",
    "fired": ["long"],
    "score": 7,
    "flipped": false
  },
  "scoring": {
    "tier_a_routing_pass": true,
    "tier_b_passed": true,
    "tier_b_quality": 4,
    "tier_b_correct": true,
    "details": {
      "russian_source_count": 3,
      "total_results": 7,
      "relevance_pct": 0.86
    }
  }
}
```

Summary file `summary.json` aggregates:
- Pass rate by mode × category
- Latency percentiles by mode
- Flipped-rate by mode
- Routing distribution
- Per-condition hit-rate

---

## 5. How scoring is implemented

In `run-eval.ps1`:

1. `Get-AutoPreferDecision` mirrors `auto_prefer()` in `src-tauri/src/engine/smart_engine.rs:169-235` (lines 91-158 of `verify-smart-engine-v3.ps1`).
2. `Test-RoutingPass` checks Tier A: `preferred_model` matches `expected_mode` table.
3. `Invoke-PromptAndScore` (Tier B) — only used in `--invoke` mode. Calls Pulse IPC, captures response, runs category-specific scoring.
4. `Test-CodeEditResponse`: regex check for code fences + keyword presence.
5. `Test-QuickAnswerResponse`: keyword match in `expected_keywords`, length check.
6. `Test-HabrSearchResponse`: count items in response, regex for `habr.com`.
7. `Test-ToolCallResponse`: parse JSON-RPC-like structure in response, verify command name.

The PowerShell scoring is intentionally simple — Roman runs `--invoke` end-to-end on R79 build, eyeballs the responses, and adjusts the rubric if needed. This is not a substitute for a full LLM-judge eval; it's a sanity check that R79's Smart Engine v3 routing matches what we'd predict on real traffic.

---

## 6. What this rubric does NOT measure

- **Long-term habit**: 100 prompts is a snapshot, not a longitudinal study. We'd need 1000+ for that.
- **Multilingual**: All 100 prompts are Russian (matching Roman's user base). English prompts may score differently.
- **Multi-turn**: Single-turn only. Conversation state is not tested.
- **Vision**: Text-only. Image-based prompts not covered.
- **Real Ollama**: The harness can call Pulse, but Pulse calls Ollama which calls the LLM. We don't have Ollama on this VM, so the `--invoke` mode requires R79 build + Ollama running.

For a deeper eval, Roman would need to run this on his dev machine with Ollama + a real LLM, capture all 300 responses (3 modes × 100 prompts), and Roman-judge each.
