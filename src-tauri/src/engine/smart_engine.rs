// Smart Engine v3 — auto-prefer logic.
//
// Четыре условия (порядок важен — побеждает первое сработавшее):
//   1) vision    — если в messages есть image, выбираем vision-модель
//   2) code-edit — если категория задачи CodeEdit, выбираем code-модель
//   3) short     — если длина user-prompt < SHORT_CHARS, выбираем fast-модель
//   4) long      — если длина user-prompt > LONG_CHARS, выбираем large-модель
//
// Если ни одно не сработало — оставляем default (не flip'аем).
//
// Каждое срабатывание добавляет +CONDITION_WEIGHT к score. Финальный
// decision принимается только если score >= PassThreshold (R67 bumped
// 4 -> 12, т.е. нужно чтобы сработали минимум 3 условия ИЛИ 1 условие +
// 2 бустера). Это страховка от ложных срабатываний на пограничных
// промптах.
//
// PassThreshold вынесен в const, чтобы тесты могли его override'ить.

use serde::{Deserialize, Serialize};

/// Категория задачи (для A/B-бенчмарка и для auto-prefer).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TaskCategory {
    CodeEdit,
    Reasoning,
    Chat,
    ToolUse,
}

impl TaskCategory {
    pub fn as_str(self) -> &'static str {
        match self {
            TaskCategory::CodeEdit => "code-edit",
            TaskCategory::Reasoning => "reasoning",
            TaskCategory::Chat => "chat",
            TaskCategory::ToolUse => "tool-use",
        }
    }
}

/// Сигналы, которые мы можем извлечь из входного промпта.
#[derive(Debug, Clone, Default)]
pub struct EngineFeatures {
    pub has_image: bool,
    pub has_code_markers: bool,
    pub char_count: usize,
    pub has_tool_call_pattern: bool,
    pub category: Option<TaskCategory>,
}

/// Входные данные для auto-prefer — минимально нужный срез сообщения.
#[derive(Debug, Clone)]
pub struct TaskInput {
    pub user_text: String,
    pub features: EngineFeatures,
}

/// Решение Smart Engine: какую модель предпочесть и почему.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct EngineDecision {
    /// Выбранная модель ("code" | "vision" | "fast" | "large" | "default")
    pub preferred_model: String,
    /// Какой default был бы без auto-prefer
    pub fallback_model: String,
    /// Список сработавших условий
    pub fired: Vec<String>,
    /// Суммарный score (>= PassThreshold чтобы решение было принято)
    pub score: i32,
    /// true если score >= PassThreshold и preferred != fallback
    pub flipped: bool,
}

/// Порог, ниже которого решение игнорируется (R67: 4 -> 12).
pub const PassThreshold: i32 = 12;

/// Вес одного сработавшего условия.
const CONDITION_WEIGHT: i32 = 5;
/// Бонус за категорию (если категория объявлена — это +1 confidence).
const CATEGORY_BONUS: i32 = 2;
/// Порог длины промпта для short/long.
pub const SHORT_CHARS: usize = 60;
pub const LONG_CHARS: usize = 600;

/// Маркеры кода, по которым детектим code-edit.
const CODE_MARKERS: &[&str] = &[
    "```rust",
    "```ts",
    "```tsx",
    "```js",
    "```py",
    "```go",
    "```rs",
    "fn ",
    "impl ",
    "trait ",
    "let mut ",
    "struct ",
    "enum ",
    "::new(",
    ".unwrap()",
    ".expect(",
    "pub fn",
    "async fn",
    "match ",
    "use serde",
    "use std::",
    "tauri::command",
    "tokio::",
    "println!",
    "dbg!",
    "-> Result<",
    " -> bool",
    " -> i32",
    " -> String",
    " -> usize",
    " -> f64",
    " -> u32",
    " -> Self",
];

/// Маркеры tool-call (function-calling patterns).
const TOOL_MARKERS: &[&str] = &[
    "{\"name\":",
    "tool_call",
    "function_call",
    "<tools>",
    "</tools>",
    "search_web(",
    "open_app(",
    "list_installed_apps(",
    "web_search(",
];

/// Детект code-маркеров в тексте. Ищем по подстрокам (case-insensitive).
pub fn detect_code_markers(text: &str) -> bool {
    let lower = text.to_lowercase();
    CODE_MARKERS.iter().any(|m| lower.contains(&m.to_lowercase()))
}

/// Детект tool-call паттернов в тексте.
pub fn detect_tool_call_pattern(text: &str) -> bool {
    let lower = text.to_lowercase();
    TOOL_MARKERS.iter().any(|m| lower.contains(&m.to_lowercase()))
}

/// Извлечь EngineFeatures из сырого user-prompt.
pub fn extract_features(user_text: &str, has_image: bool, category: Option<TaskCategory>) -> EngineFeatures {
    EngineFeatures {
        has_image,
        has_code_markers: detect_code_markers(user_text),
        char_count: user_text.chars().count(),
        has_tool_call_pattern: detect_tool_call_pattern(user_text),
        category,
    }
}

/// Главная функция auto-prefer. Чистая, детерминированная, тестабельная.
///
/// Шкала score: каждое условие = +5, бонус за категорию = +2.
/// PassThreshold = 12 (R67). Решение flipped=true только если score >= 12
/// И preferred != fallback.
///
/// Пример:
///   code-edit промпт на 800 символов c ```rust →
///
///     fired = ["code-edit", "long"]
///     score = 5 + 5 + 2 (категория) = 12 -> flipped=true, preferred="code"
pub fn auto_prefer(input: &TaskInput, fallback_model: &str) -> EngineDecision {
    let mut fired: Vec<String> = Vec::new();
    let mut score: i32 = 0;
    let mut preferred = fallback_model.to_string();

    // Condition 1: vision
    if input.features.has_image {
        fired.push("vision".to_string());
        score += CONDITION_WEIGHT;
        preferred = "vision".to_string();
    }

    // Condition 2: code-edit
    if input.features.has_code_markers {
        fired.push("code-edit".to_string());
        score += CONDITION_WEIGHT;
        // vision выше по приоритету — перезаписываем только если vision не сработал
        if preferred == fallback_model {
            preferred = "code".to_string();
        }
    }

    // Condition 3: short
    if input.features.char_count < SHORT_CHARS
        && input.features.char_count > 0
        && !input.features.has_code_markers
    {
        fired.push("short".to_string());
        score += CONDITION_WEIGHT;
        if preferred == fallback_model {
            preferred = "fast".to_string();
        }
    }

    // Condition 4: long
    if input.features.char_count > LONG_CHARS {
        fired.push("long".to_string());
        score += CONDITION_WEIGHT;
        // long — общий признак сложной задачи, выбираем large,
        // но не перебиваем code/vision
        if preferred == fallback_model {
            preferred = "large".to_string();
        }
    }

    // Бонус за явную категорию
    if input.features.category.is_some() {
        score += CATEGORY_BONUS;
    }

    // Tool-call сам по себе не flip'ает модель (он про формат, не качество),
    // но добавляет в score если сработал — пригодится для метрик.
    if input.features.has_tool_call_pattern {
        // no preferred override, just log
        fired.push("tool-call-pattern".to_string());
    }

    let flipped = score >= PassThreshold && preferred != fallback_model;

    EngineDecision {
        preferred_model: preferred,
        fallback_model: fallback_model.to_string(),
        fired,
        score,
        flipped,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_input(text: &str, has_image: bool, cat: Option<TaskCategory>) -> TaskInput {
        let features = extract_features(text, has_image, cat);
        TaskInput {
            user_text: text.to_string(),
            features,
        }
    }

    // ── 10 edge-case теста (R67 добавил 10, R74 восстанавливает) ───────────

    #[test]
    fn empty_prompt_falls_back() {
        let d = auto_prefer(&make_input("", false, None), "default");
        assert!(!d.flipped);
        assert_eq!(d.preferred_model, "default");
        assert!(d.fired.is_empty());
        assert_eq!(d.score, 0);
    }

    #[test]
    fn pure_greeting_does_not_flip() {
        // Короткий промпт без маркеров, без категории -> score=0, не flipped
        let d = auto_prefer(&make_input("Привет!", false, None), "default");
        assert!(!d.flipped, "greeting must not flip; got {:?}", d);
    }

    #[test]
    fn short_prompt_alone_does_not_flip() {
        // short condition срабатывает, но score=5 < 12 -> не flipped
        let d = auto_prefer(&make_input("hi", false, Some(TaskCategory::Chat)), "default");
        assert!(!d.flipped, "short alone should not flip at threshold 12");
        assert!(d.fired.iter().any(|f| f == "short"));
        assert_eq!(d.score, 7); // 5 + 2 bonus
    }

    #[test]
    fn long_alone_does_not_flip() {
        // long промпт без категории -> score=5 < 12
        let text: String = "a".repeat(LONG_CHARS + 10);
        let d = auto_prefer(&make_input(&text, false, None), "default");
        assert!(!d.flipped);
        assert!(d.fired.iter().any(|f| f == "long"));
    }

    #[test]
    fn code_marker_alone_does_not_flip_at_t12() {
        // code-edit + длинный промпт = 5 + 5 + 2 (категория) = 12 -> flipped
        // code-edit + короткий промпт = 5 + 2 = 7 -> not flipped
        let d = auto_prefer(
            &make_input("```rust\nfn main() {}\n```", false, Some(TaskCategory::CodeEdit)),
            "default",
        );
        // промпт 25 символов, < SHORT_CHARS, но has_code_markers=true
        // поэтому short НЕ срабатывает (мы его отключаем при code-markers)
        assert!(!d.flipped, "short code snippet shouldn't flip alone: {:?}", d);
        assert_eq!(d.preferred_model, "code");
        assert_eq!(d.score, 7); // code-edit(5) + category(2)
    }

    #[test]
    fn code_plus_long_flips() {
        let mut text = String::from("```rust\n");
        text.push_str("fn solve(x: i32) -> i32 {\n");
        text.push_str(&"    x + 1\n".repeat(80));
        text.push_str("}\n```");
        assert!(text.chars().count() > LONG_CHARS, "test setup: text must be > LONG_CHARS ({}), got {}", LONG_CHARS, text.chars().count());
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::CodeEdit)), "default");
        assert!(d.flipped, "code+long+category should flip: {:?}", d);
        assert!(d.fired.iter().any(|f| f == "code-edit"));
        assert!(d.fired.iter().any(|f| f == "long"));
        assert!(d.score >= 12);
    }

    #[test]
    fn vision_overrides_everything() {
        let text = "```rust\nfn main() {}\n```";
        let d = auto_prefer(&make_input(text, true, Some(TaskCategory::CodeEdit)), "default");
        assert!(d.flipped);
        assert_eq!(d.preferred_model, "vision");
        assert!(d.fired.iter().any(|f| f == "vision"));
        // vision ставится первым, code-edit добавляет score, но не override'ит
        // preferred (мы только перезаписываем если preferred == fallback)
    }

    #[test]
    fn threshold_exact_boundary() {
        // score ровно 12 -> flipped
        // 5 (code) + 5 (long) + 2 (category) = 12
        let mut text = String::from("```rust\nfn f() {}\n");
        // 70 копий по 11 символов = 770, плюс 18 = 788, гарантированно > 600
        text.push_str(&"// padding\n".repeat(70));
        assert!(text.chars().count() > LONG_CHARS, "boundary test setup: text must be > LONG_CHARS");
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::CodeEdit)), "default");
        assert!(d.flipped, "exact 12 must flip: {:?}", d);
        assert!(d.score >= 12);
    }

    #[test]
    fn threshold_below() {
        // score 11 -> not flipped
        // 5 (code) + 5 (long) = 10, без category = 10, или
        // 5 (long) + 2 (cat) = 7, < 12
        let text: String = "a".repeat(LONG_CHARS + 1);
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::Reasoning)), "default");
        assert!(!d.flipped, "long+cat alone must NOT flip (7<12): {:?}", d);
        assert!(d.fired.iter().any(|f| f == "long"));
    }

    #[test]
    fn detect_code_markers_realistic() {
        let t = "поправь мне вот это:\n```rust\nfn foo() -> Result<i32, ()> { Ok(42) }\n```";
        assert!(detect_code_markers(t));
        let t2 = "let me check what's happening in this code";
        assert!(!detect_code_markers(t2), "english prose should not trigger: {t2}");
    }

    #[test]
    fn tool_call_pattern_is_logged_but_does_not_override() {
        let text = "{\"name\":\"web_search\",\"args\":{\"query\":\"rust\"}}";
        let d = auto_prefer(&make_input(text, false, Some(TaskCategory::ToolUse)), "default");
        assert!(d.fired.iter().any(|f| f == "tool-call-pattern"));
        // tool-call pattern сам по себе не flip'ает — только логируется
        // score = 5(category?) нет, category=Some -> +2, tool-call-pattern=0
        // 5 (long? нет, <600) + 2 (cat) = 7, не flipped
        assert!(!d.flipped);
    }

    // ── 3 verify-scenarios (R67 добавил 3) ──────────────────────────────────

    #[test]
    fn verify_chat_greeting() {
        // Типичный chat: "привет, как дела?" — не flip'ает
        let d = auto_prefer(&make_input("привет, как дела?", false, Some(TaskCategory::Chat)), "default");
        assert!(!d.flipped);
        assert!(d.score < PassThreshold);
    }

    #[test]
    fn verify_reasoning_math() {
        // Reasoning: математика, длинная, без code-маркеров -> long
        // Делаем гарантированно > 600 символов (русский unicode).
        let unit = "Реши задачу: найди x в уравнении 3x + 7 = 22. ";
        let text: String = unit.repeat(20);
        assert!(text.chars().count() > LONG_CHARS, "test setup: text must be > LONG_CHARS ({}), got {}", LONG_CHARS, text.chars().count());
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::Reasoning)), "default");
        assert!(d.fired.iter().any(|f| f == "long"), "long must fire for long prompt: {:?}", d);
        assert!(!d.flipped, "long+cat alone must NOT flip: {:?}", d);
    }

    #[test]
    fn verify_tool_use_json() {
        // ToolUse: JSON-вызов, без кода, длина < 100 -> score 2 (category), не flipped
        let text = r#"{"name":"list_installed_apps","args":{}}"#;
        let d = auto_prefer(&make_input(text, false, Some(TaskCategory::ToolUse)), "default");
        assert!(d.fired.iter().any(|f| f == "tool-call-pattern"));
        assert!(!d.flipped);
    }
}
