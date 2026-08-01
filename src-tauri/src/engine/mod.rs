// Pulse v5 — Smart Engine v3 (R74 reconstruction).
//
// NOTE R74: Smart Engine v3 was integrated in R67 (commit bg_be0bd69a on
// the H:\ mirror) and re-confirmed by the A/B scaffold audit. The 2026-08-01
// data-loss incident cleared the H:\ working tree, so the source had to be
// reconstructed from the documented design intent (4 auto-prefer conditions,
// A/B JSONL log + 7-day rotation, PassThreshold 4 -> 12). Wire-compatible
// with v0.5.2 surface area: `auto_prefer(...)`, `EngineDecision`,
// `TaskCategory`, `ab_log_path()`. The shape mirrors what R67 produced so
// downstream callers (web/src/llm/tools.ts, ChatView.tsx) keep working.
//
// Подмодули:
//   - smart_engine: ядро auto-prefer (4 условия + PassThreshold)
//   - ab_log: append-only JSONL лог + 7-day rotation
//   - tasks: синтетические 50 задач для A/B-бенчмарка (код, рассуждения,
//     чат, tool-use)
//
// Без побочных эффектов: Tauri-команды не вешаем, чистая логика + log-файл.

pub mod ab_log;
pub mod smart_engine;
pub mod tasks;

pub use ab_log::{ab_log_path, AbLogEntry, AbLogWriter};
pub use smart_engine::{
    auto_prefer, EngineDecision, EngineFeatures, PassThreshold, TaskCategory, TaskInput,
};
pub use tasks::{synthesize_tasks, SynthTask};
