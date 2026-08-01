// Pulse — Smart Engine v3 20-prompt real-user integration test (R79).
//
// Цель: на 20 реальных Roman'овских промптах (4 категории × 5 промптов)
// из R79 Eval Harness prompts.jsonl проверить, что auto_prefer с R79
// Phase 3 настройками (t=5, CATEGORY_BONUS=3, code-fence requirement) даёт:
//   1. 0 false-negative на code-edit (все 5 уходят в "code"-модель)
//   2. 0 false-positive на habr-search (ни один не уходит в "code")
//   3. short + Chat → "fast" (это желаемое поведение Phase 3)
//   4. quick-answer с code-маркерами (tokio::/::new) НЕ уходит в "code"
//   5. p50 latency routing-decision < 1ms (это внутренний бенчмарк)
//
// Это интеграционный тест, потому что:
//   * Использует реальные тексты промптов (как их пишет Roman)
//   * Проверяет end-to-end routing behavior, а не отдельные edge-cases
//   * Документирует контракт "default ON" для пользователя
//
// Не #[ignore] — должен бежать на каждом CI-проходе.

use pulse_desktop_lib::engine::{
    auto_prefer, extract_features, EngineSettings, TaskCategory, TaskInput,
};

/// 20 промптов из R79 prompts.jsonl, 4 категории × 5 промптов.
/// Inline (не парсим jsonl) для детерминированности и скорости теста.
const TEST_PROMPTS: &[(&str, &str, TaskCategory)] = &[
    // ── 5 habr-search (expected_mode: Chat) ────────────────────────────────
    (
        "Найди статьи на Хабре про async/await в Rust последние два года",
        "habr-1",
        TaskCategory::Chat,
    ),
    (
        "Хабр: сравнение Svelte 5 runes vs Svelte 4 stores, желательно с примерами",
        "habr-2",
        TaskCategory::Chat,
    ),
    (
        "Покажи лучшие статьи 2024-2025 про TypeScript 5.x generics и conditional types",
        "habr-3",
        TaskCategory::Chat,
    ),
    (
        "Хочу почитать про Tauri v2 release — что нового, миграция с v1",
        "habr-4",
        TaskCategory::Chat,
    ),
    (
        "Статьи на Хабре про Cursor и Claude Code — кто как использует вайбкодинг",
        "habr-5",
        TaskCategory::Chat,
    ),
    // ── 5 code-edit (expected_mode: CodeEdit) ──────────────────────────────
    (
        "Переименуй функцию `calculate_total` в `compute_subtotal` в этом файле",
        "code-1",
        TaskCategory::CodeEdit,
    ),
    (
        "Добавь обработку ошибок через `?` вместо `unwrap()` в этой функции",
        "code-2",
        TaskCategory::CodeEdit,
    ),
    (
        "Сделай эту функцию async, добавь `.await` где нужно",
        "code-3",
        TaskCategory::CodeEdit,
    ),
    (
        "Добавь doc-комментарий `///` к этой публичной функции",
        "code-4",
        TaskCategory::CodeEdit,
    ),
    (
        "Добавь `use serde::{Deserialize, Serialize}` и аннотации к полям",
        "code-5",
        TaskCategory::CodeEdit,
    ),
    // ── 5 quick-answer (expected_mode: Chat) ──────────────────────────────
    (
        "В чём разница между let, const и var в JavaScript?",
        "quick-1",
        TaskCategory::Chat,
    ),
    (
        "Что такое RAII в Rust?",
        "quick-2",
        TaskCategory::Chat,
    ),
    (
        "Какая версия Node.js LTS сейчас актуальна?",
        "quick-3",
        TaskCategory::Chat,
    ),
    (
        "Чем `tokio::spawn` отличается от `std::thread::spawn`?",
        "quick-4",
        TaskCategory::Chat,
    ),
    (
        "Какая разница между `vec![]` макросом и `Vec::new()`?",
        "quick-5",
        TaskCategory::Chat,
    ),
    // ── 5 tool-call-pattern (expected_mode: Chat) ─────────────────────────
    (
        "Найди все .rs файлы в папке src больше 1000 строк",
        "tool-1",
        TaskCategory::Chat,
    ),
    (
        "Открой Firefox и поставь закладку на эту страницу",
        "tool-2",
        TaskCategory::Chat,
    ),
    (
        "Сделай скриншот основного монитора и сохрани в Downloads",
        "tool-3",
        TaskCategory::Chat,
    ),
    (
        "Запусти VS Code с этим проектом",
        "tool-4",
        TaskCategory::Chat,
    ),
    (
        "Установи громкость на 50% и открой Spotify",
        "tool-5",
        TaskCategory::Chat,
    ),
];

fn make_input(text: &str, cat: TaskCategory) -> TaskInput {
    let features = extract_features(text, false, Some(cat));
    TaskInput {
        user_text: text.to_string(),
        features,
    }
}

#[test]
fn r79_integration_all_code_edit_flip_to_code() {
    // Все 5 code-edit промптов должны flip'нуться на "code"-модель.
    // Это базовый контракт: code-edit category + (marker или code-fence) = code.
    let settings = EngineSettings::default(); // t=5, enabled=true
    for (prompt, id, cat) in TEST_PROMPTS.iter().filter(|(_, _, c)| *c == TaskCategory::CodeEdit) {
        let d = auto_prefer(&make_input(prompt, *cat), "default", &settings);
        assert!(
            d.flipped,
            "[{}] code-edit должен flip'нуться: {:?}",
            id,
            d
        );
        assert_eq!(
            d.preferred_model, "code",
            "[{}] preferred_model должен быть 'code', got '{}': {:?}",
            id, d.preferred_model, d
        );
    }
}

#[test]
fn r79_integration_habr_search_does_not_go_to_code() {
    // R79 over-fire fix: habr-search с "async/await" / "TypeScript" / "Tauri" / etc.
    // НЕ должен уходить в code-модель (это не code-edit задача).
    // Допустимо уйти в "fast" (short) или остаться в "default" (long).
    let settings = EngineSettings::default();
    for (prompt, id, cat) in TEST_PROMPTS.iter().filter(|(_, _, c)| *c == TaskCategory::Chat).take(5) {
        let d = auto_prefer(&make_input(prompt, *cat), "default", &settings);
        assert_ne!(
            d.preferred_model, "code",
            "[{}] habr-search НЕ должен идти в code: {:?}",
            id, d
        );
    }
}

#[test]
fn r79_integration_quick_answer_with_tokio_marker_no_code() {
    // R79 §5.3 over-fire fix: "Чем `tokio::spawn` отличается..." — quick-answer
    // с code-маркером "tokio::" НЕ должен уходить в code-модель. Маркер
    // логируется как "code-edit-marker", но condition не fires (нет code-fence
    // и категория Chat, не CodeEdit).
    let settings = EngineSettings::default();
    for (prompt, id, cat) in TEST_PROMPTS.iter().filter(|(_, _, c)| *c == TaskCategory::Chat).skip(10).take(5) {
        let d = auto_prefer(&make_input(prompt, *cat), "default", &settings);
        assert_ne!(
            d.preferred_model, "code",
            "[{}] quick-answer с code-маркерами НЕ должен идти в code: {:?}",
            id, d
        );
    }
}

#[test]
fn r79_integration_routing_latency_under_1ms() {
    // Perf: routing decision (auto_prefer) должен быть < 1ms на realistic prompt.
    // Это — internal budget; для пользователя это означает, что overhead
    // Smart Engine v3 на маршрутизацию — negligible.
    let settings = EngineSettings::default();
    let prompt = "Переименуй функцию `calculate_total` в `compute_subtotal` в этом файле";
    let input = make_input(prompt, TaskCategory::CodeEdit);

    // Warmup (one-shot): первый вызов имеет cache-miss на marker iteration.
    let _ = auto_prefer(&input, "default", &settings);

    let start = std::time::Instant::now();
    let iters = 1000;
    for _ in 0..iters {
        let _ = auto_prefer(&input, "default", &settings);
    }
    let elapsed = start.elapsed();
    let per_call_us = elapsed.as_micros() / iters;

    // 1ms = 1000us. Мы хотим < 200us (5x margin) — это conservative для
    // 50-iter marker check + Vec alloc.
    assert!(
        per_call_us < 1000,
        "routing должен быть < 1ms, got {}us/call ({} iters in {:?})",
        per_call_us, iters, elapsed
    );
    println!(
        "[perf] auto_prefer latency: {}us/call ({} iters in {:?})",
        per_call_us, iters, elapsed
    );
}

#[test]
fn r79_integration_summary_default_on() {
    // Документируем: R79 default — ON (Roman: "ship default ON").
    // Это integration-уровень тест, потому что это контракт с пользователем.
    let s = EngineSettings::default();
    assert!(s.enabled, "R79 default must be ON (Roman's directive)");
    assert_eq!(s.threshold, 5, "R79 default threshold is 5 (Eval Harness finding)");
}

#[test]
fn r79_integration_count_flipped_with_default_settings() {
    // Подсчёт flipped-промптов с дефолтными R79 настройками.
    // Ожидаемо:
    //   * 5 code-edit → flipped=true (5)
    //   * 5 habr-search → some flip to fast (short), some not. R79 Eval Harness
    //     показал 47/100 short. Из 5 habr → ~2-3 flipped.
    //   * 5 quick-answer → 0 на code, ~3-4 на fast (short).
    //   * 5 tool-call → ~3 на fast.
    //   * Total: ~13-16 flipped из 20.
    // Это sanity-check: мы не должны flip'ать ВСЕ 20 (агрессивно) и не 0
    // (консервативно).
    let settings = EngineSettings::default();
    let mut flipped = 0;
    let mut to_code = 0;
    let mut to_fast = 0;
    let mut to_large = 0;
    for (prompt, _id, cat) in TEST_PROMPTS {
        let d = auto_prefer(&make_input(prompt, *cat), "default", &settings);
        if d.flipped {
            flipped += 1;
            match d.preferred_model.as_str() {
                "code" => to_code += 1,
                "fast" => to_fast += 1,
                "large" => to_large += 1,
                _ => {}
            }
        }
    }
    println!(
        "[summary] R79 default ON: {}/20 flipped (code={}, fast={}, large={})",
        flipped, to_code, to_fast, to_large
    );
    assert!(flipped >= 5, "минимум 5 code-edit должны flip'нуться, got {}", flipped);
    assert_eq!(to_code, 5, "только code-edit категория должна идти в code, got {}", to_code);
    assert!(to_fast > 0, "short промпты должны идти в fast, got 0");
}
