// Pulse v5 — Smart Engine v3 (R74 reconstruction + R79 Phase 3 + R82 tree-sitter).
//
// R74: Smart Engine v3 was integrated in R67 (commit bg_be0bd69a on
// the H:\ mirror) and re-confirmed by the A/B scaffold audit. The 2026-08-01
// data-loss incident cleared the H:\ working tree, so the source had to be
// reconstructed from the documented design intent (4 auto-prefer conditions,
// A/B JSONL log + 7-day rotation, PassThreshold 4 -> 12). Wire-compatible
// with v0.5.2 surface area: `auto_prefer(...)`, `EngineDecision`,
// `TaskCategory`, `ab_log_path()`. The shape mirrors what R67 produced so
// downstream callers (web/src/llm/tools.ts, ChatView.tsx) keep working.
//
// R79 Phase 3 changes:
//   * `EngineSettings` exposed (enabled + threshold, default ON + t=8).
//   * `auto_prefer()` signature gains `settings: &EngineSettings` parameter.
//   * `PASS_THRESHOLD` lowered 12 → 8 (R75 recommendation).
//   * `MIN_THRESHOLD`/`MAX_THRESHOLD` constants added for Tauri command
//     input validation.
//   * Perf: lowercase computed once, cached marker slices via OnceLock,
//     `Vec::with_capacity(5)` for `fired`.
//
// R82: tree-sitter structural parser.
//   * `parser::CodeParser` — Rust/TS/JS парсер с extract_fence_blocks +
//     extract_inline_backticks fallback для markdown-кода.
//   * `EngineDecision` получил `code_parse_signal: bool` и `low_confidence: bool`.
//   * `auto_prefer` подтверждает code-edit через `parser::is_code_construct`
//     перед flip'ом, и помечает low_confidence если только Russian-verb intent.
//
// Подмодули:
//   - smart_engine: ядро auto-prefer (4 условия + threshold + settings +
//     R82 structural code-confirm)
//   - ab_log: append-only JSONL лог + 7-day rotation
//   - tasks: синтетические 50 задач для A/B-бенчмарка (код, рассуждения,
//     чат, tool-use)
//   - parser: tree-sitter AST парсер (R82)
//
// Без побочных эффектов: Tauri-команды не вешаем, чистая логика + log-файл.

pub mod ab_log;
pub mod parser;
pub mod smart_engine;
pub mod tasks;

pub use ab_log::{ab_log_path, AbLogEntry, AbLogWriter};
pub use parser::{CodeLanguage, CodeParser, ParseResult};
pub use smart_engine::{
    auto_prefer, detect_code_markers, detect_tool_call_pattern, extract_features, EngineDecision,
    EngineFeatures, EngineSettings, TaskCategory, TaskInput, MAX_THRESHOLD, MIN_THRESHOLD,
    PASS_THRESHOLD,
};
pub use tasks::{synthesize_tasks, SynthTask};
