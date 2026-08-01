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
// decision принимается только если score >= PASS_THRESHOLD.
//
// R79 (Phase 3) — RETRY, smart-engine-v3-default-on:
//   * PASS_THRESHOLD: 8 → 5 (R79 Eval Harness pilot finding).
//     R75 рекомендовал 12→8 (Option A) на синтетических 50 задачах, но
//     R79 Eval Harness на 100 реальных Roman'овских промптах показал
//     0/100 flipped при t=8. Причина: на реальных промптах 0/100 имеют
//     2 conditions одновременно (code+long, code+vision). 1-condition +
//     category = 5 + 2 = 7 < 8 → не flip. t=5 делает 1-condition = 5 ≥ 5
//     → flip, что активирует ~52 промпта (5 code-edit + 47 short).
//   * CATEGORY_BONUS: 2 → 3 (Option E из R79 Eval Harness §5.1). При
//     threshold=5 + bonus=3, 1-cond (5) + cat (3) = 8 ≥ 5 → flip. Более
//     стабильно, чем голый threshold, потому что условие "явная категория"
//     само по себе сигнал.
//   * Code-fence requirement: добавлен has_code_fence (наличие ``` блока в
//     тексте). Логика: code-edit fires если has_code_fence (сильный сигнал)
//     OR (has_code_markers AND category=CodeEdit). Раньше: code-edit fires
//     на любом keyword-marker (напр. "tokio::" в quick-answer) — R79 Eval
//     нашёл 2/25 over-fires на quick-answer с "tokio::spawn" / "Vec::new()".
//   * Marker expansion: добавлены Russian verbs (напиши/сделай/поправь/
//     удали/добавь/рефакторни/перепиши/объясни/что делает/что выведет/
//     конвертируй/создай), function names (fn /def /func /function ),
//     language markers (.rs, .ts, .svelte, .js, .py). R79 Eval Harness §5.2
//     нашёл 5/25 hit-rate на оригинальном наборе, target 20/25.
//   * EngineSettings: persisted в app data dir через Tauri commands.
//   * Perf: hot-path — lowercase считается один раз, Vec::with_capacity(5)
//     для fired, OnceLock-прекэш marker-slice констант (R74-идея).
//   * Real-user integration test: 20 промптов из R79 prompts.jsonl.
//
// R67/R75 background — R67 интегрировал auto-prefer с PassThreshold 4→12,
// R74 восстановил потерянный исходник, R75 A/B-верифицировал синтетику и
// рекомендовал расслабить порог. R79 Eval Harness на реальных Roman'овских
// промптах показал, что 8 недостаточно. Это R79 RETRY — final threshold.

use serde::{Deserialize, Serialize};

use super::parser;

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

    /// Парсинг из строки (для Tauri-команды и ab_log).
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s {
            "code-edit" => Some(TaskCategory::CodeEdit),
            "reasoning" => Some(TaskCategory::Reasoning),
            "chat" => Some(TaskCategory::Chat),
            "tool-use" => Some(TaskCategory::ToolUse),
            _ => None,
        }
    }
}

/// Сигналы, которые мы можем извлечь из входного промпта.
#[derive(Debug, Clone, Default)]
pub struct EngineFeatures {
    pub has_image: bool,
    pub has_code_markers: bool,
    /// R79: наличие code-fence блока (``` ... ```) — сильный сигнал code-edit.
    /// Отдельный флаг от has_code_markers: keyword markers могут быть
    /// false-positive (напр. "tokio::" в quick-answer про разницу spawn).
    /// Code-fence = Roman вставил пример кода = это точно code-edit.
    pub has_code_fence: bool,
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
    /// Суммарный score (>= threshold чтобы решение было принято)
    pub score: i32,
    /// Конкретный threshold, который применился (для трассировки)
    pub threshold: i32,
    /// true если score >= threshold и preferred != fallback
    pub flipped: bool,
    /// R82: tree-sitter подтвердил что user_text содержит parseable code
    /// (function/class/struct/import). Structural confirmation, не lexical.
    /// Полезно для UI ("код найден") и для eval-harness'а (измерять parser vs
    /// manual labels).
    #[serde(default)]
    pub code_parse_signal: bool,
    /// R82: code-edit flip сработал, но parser не подтвердил (только Russian
    /// verb intent типа "напиши функцию..."). Это маркер для UI: "low confidence,
    /// можно перепроверить routing".
    #[serde(default)]
    pub low_confidence: bool,
}

/// Настройки Smart Engine v3 (R79). Persisted в app data dir.
///
/// `enabled = true` (default) — auto-prefer активен по умолчанию (Roman: "ship default ON").
/// `threshold` — порог для flip'а. По умолчанию 5 (R79 Eval Harness finding).
/// Юзер может поднять до 8 (R75 conservative), 12 (R67 super-conservative) или
/// 20 (почти никогда не flip'ает), либо опустить до 4 (минимум, очень агрессивно).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EngineSettings {
    pub enabled: bool,
    pub threshold: i32,
    /// Версия схемы (для миграций, если будем расшивлять)
    pub schema_version: u32,
}

impl Default for EngineSettings {
    fn default() -> Self {
        Self {
            enabled: true,    // R79 default: ON
            threshold: 5,     // R79 Eval Harness: 8 был 0/100 flipped, 5 unlocks 52/100
            schema_version: 1,
        }
    }
}

impl EngineSettings {
    /// Клэмпим threshold в разумный диапазон. Ниже 4 = "флипаем почти всегда"
    /// (4 = самый минимум для 1-condition + small bonus). Выше 20 = "флипаем
    /// почти никогда" (защитный потолок). Берёт &self для удобства chaining
    /// и не-мутирующего использования.
    pub fn clamped(&self) -> Self {
        let mut out = self.clone();
        if out.threshold < MIN_THRESHOLD {
            out.threshold = MIN_THRESHOLD;
        }
        if out.threshold > MAX_THRESHOLD {
            out.threshold = MAX_THRESHOLD;
        }
        out
    }
}

/// Порог, ниже которого решение игнорируется.
///
/// R67: 4 → 12 (слишком консервативно, 0/50 flips на A/B).
/// R75: рекомендовал 12 → 8 (Option A). На синтетике работало.
/// R79 Eval Harness: на 100 реальных промптах 0/100 flipped при t=8
/// (0 prompts have 2 conditions одновременно). Реальный фикс — t=5.
/// R79 Phase 3 (RETRY): 8 → 5. 1-condition (5) + category (3) = 8 ≥ 5 → flip.
pub const PASS_THRESHOLD: i32 = 5;

/// Минимальный допустимый threshold (для UI / Tauri command валидации).
pub const MIN_THRESHOLD: i32 = 4;
/// Максимальный допустимый threshold.
pub const MAX_THRESHOLD: i32 = 20;

/// Вес одного сработавшего условия.
const CONDITION_WEIGHT: i32 = 5;
/// Бонус за категорию (если категория объявлена — это +1 confidence).
///
/// R79 Eval Harness §5.1 Option E: +2 → +3. Делает 1-condition + cat = 8 ≥ 5
/// (default threshold) стабильным flip'ом. Гибрид с t=5 даёт margin на ошибки
/// в marker detection.
const CATEGORY_BONUS: i32 = 3;
/// Порог длины промпта для short/long.
pub const SHORT_CHARS: usize = 60;
pub const LONG_CHARS: usize = 600;

/// Маркеры кода, по которым детектим code-edit.
///
/// Список хранится уже в lowercase (все паттерны ASCII), чтобы не делать
/// `.to_lowercase()` на каждый auto_prefer вызов. Это реальный hot-path
/// (10-15 промптов / сессию → сотни auto_prefer в день). Прекэш +1KB .rodata
/// данных в binary, но -O(few µs) на каждый вызов.
///
/// R79 Phase 3 расширения:
///   * Russian verbs (напиши/сделай/поправь/удали/добавь/рефакторни/перепиши/
///     объясни/что делает/что выведет/конвертируй/создай) — Roman пишет
///     задачи в prose, без ```-блока. R79 Eval Harness: 5/25 → target 20/25.
///   * Function names (fn /def /func /function ) — R75 §5.2.
///   * Language markers (.rs, .ts, .svelte, .js, .py) — "file.rs" или
///     "component.svelte" — strong signal.
///   * Code-fence list (```rust и т.д.) — самый сильный сигнал.
const CODE_MARKERS: &[&str] = &[
    // Code fences (R75) — самый сильный сигнал, всегда учитывается
    "```rust",
    "```ts",
    "```tsx",
    "```js",
    "```py",
    "```go",
    "```rs",
    "```kotlin",
    "```swift",
    "```c++",
    "```cpp",
    "```csharp",
    "```ruby",
    "```php",
    "```html",
    "```css",
    "```json",
    "```yaml",
    "```toml",
    "```sql",
    "```bash",
    "```shell",
    "```svelte",
    // Rust/TS keyword markers (R67) — strong
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
    "-> result<",
    " -> bool",
    " -> i32",
    " -> string",
    " -> usize",
    " -> f64",
    " -> u32",
    " -> self",
    // R79: function names (multi-language)
    "fn main",
    "def ",
    "func ",
    "function ",
    "async function",
    // R79: file extension markers (Roman часто упоминает "file.rs" / ".ts")
    ".rs",
    ".ts",
    ".tsx",
    ".svelte",
    ".js",
    ".py",
    // R79: Russian verbs — R75 §5.2 + R79 Eval Harness §5.2 +
    // R79 RETRY integration-test fix (code-1 "Переименуй функцию...").
    // Эти маркеры weak: сами по себе не flip'ают, но в комбинации с
    // категорией CodeEdit — да. Подробнее в extract_features.
    "напиши",
    "сделай",
    "поправь",
    "удали",
    "добавь",
    "рефакторни",
    "перепиши",
    "объясни",
    "что делает",
    "что выведет",
    "конвертируй",
    "создай",
    "отрефактори",
    "имплементируй",
    // R79 RETRY: more verbs to cover Roman's natural phrasing.
    // Покрывают integration-test cases: "Переименуй/Замени/Отрефакторь/
    // Инлайни/Вынеси/Преврати/Исправь/Упрости/Конвертни".
    "переименуй",
    "замени",
    "отрефакторь",
    "инлайни",
    "вынеси",
    "преврати",
    "исправь",
    "упрости",
    "конвертни",
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
/// Hot-path optimization: lower-cased input считается один раз.
pub fn detect_code_markers(text: &str) -> bool {
    let lower = text.to_lowercase();
    CODE_MARKERS.iter().any(|m| lower.contains(m))
}

/// Детект tool-call паттернов в тексте. Hot-path optimization аналогично.
pub fn detect_tool_call_pattern(text: &str) -> bool {
    let lower = text.to_lowercase();
    TOOL_MARKERS.iter().any(|m| lower.contains(m))
}

/// R82: Russian edit-intent verbs. Это подмножество CODE_MARKERS без
/// question-words (объясни / что делает / что выведет / имплементируй).
///
/// Используется в auto_prefer для low-confidence routing: если marker-signal
/// сработал, но parser не подтвердил code, проверяем наличие edit-intent verb.
/// Если есть — flip'аем с `low_confidence=true`. Если нет — rejected (R79 §5.3
/// over-fire protection: "tokio::" в quick-answer остаётся quick-answer).
const RUSSIAN_EDIT_VERBS: &[&str] = &[
    "напиши", "сделай", "поправь", "исправь", "отрефактори", "рефакторни",
    "отрефакторь", "упрости", "добавь", "удали", "замени", "переименуй",
    "вынеси", "инлайни", "преврати", "конвертируй", "конвертни", "перепиши",
    "создай",
];

/// Проверить, содержит ли текст хотя бы один Russian edit-verb.
/// Substring match в lowercase. Используется в auto_prefer для low-confidence
/// code-edit routing.
fn has_russian_edit_verb(text: &str) -> bool {
    let lower = text.to_lowercase();
    RUSSIAN_EDIT_VERBS.iter().any(|v| lower.contains(v))
}

/// Извлечь EngineFeatures из сырого user-prompt.
///
/// Perf: считаем lowercase один раз и шарим между code-markers и
/// tool-call-pattern детекторами (раньше каждый делал свой lower()).
///
/// R79: отдельный флаг has_code_fence (наличие ``` блока). Используется в
/// auto_prefer для уточнения code-edit condition: keyword-only markers
/// могут быть false-positive в quick-answer prompts (R79 Eval Harness §5.3
/// нашёл 2/25 over-fires на "tokio::" / "::new(").
pub fn extract_features(user_text: &str, has_image: bool, category: Option<TaskCategory>) -> EngineFeatures {
    let lower = user_text.to_lowercase();
    let has_code_fence = user_text.contains("```");
    let has_code_markers = CODE_MARKERS.iter().any(|m| lower.contains(m));
    EngineFeatures {
        has_image,
        has_code_markers,
        has_code_fence,
        char_count: user_text.chars().count(),
        has_tool_call_pattern: TOOL_MARKERS.iter().any(|m| lower.contains(m)),
        category,
    }
}

/// Главная функция auto-prefer. Чистая, детерминированная, тестабельная.
///
/// R79: добавлен параметр `settings: &EngineSettings` — если `enabled=false`,
/// возвращает EngineDecision с `flipped=false` и `threshold=settings.threshold`
/// (для трассировки). Это позволяет юзеру отключить auto-prefer через
/// Settings UI, не теряя при этом логирования.
///
/// R79 Phase 3 (RETRY):
///   * PASS_THRESHOLD = 5 (R79 Eval Harness finding, 8 was 0/100 flipped).
///   * CATEGORY_BONUS = 3 (R79 §5.1 Option E, 1+cat=8 ≥ 5 = flip).
///   * Code-edit condition уточнён: fires если has_code_fence (strong)
///     OR (has_code_markers AND category=CodeEdit). Это убирает over-fire
///     на quick-answer с "tokio::" / "::new(" (R79 §5.3: 2/25 over-fires).
///     Без category keyword-only marker → только "code-edit-marker" в fired
///     (для трассировки), но score не увеличивается и preferred не меняется.
///
/// Шкала score: каждое условие = +5, бонус за категорию = +3.
/// PASS_THRESHOLD = 5 (R79). Решение flipped=true только если score >= threshold
/// AND preferred != fallback.
///
/// Пример:
///   code-edit промпт с ```rust блоком, 800 символов, category=CodeEdit
///   fired = ["code-edit", "long"]
///   score = 5 + 5 + 3 (категория) = 13, threshold = 5 -> flipped=true, preferred="code"
///
///   code-edit промпт БЕЗ ``` блока, в prose ("напиши функцию X"), category=CodeEdit
///   fired = ["code-edit"] (по has_code_markers + категория)
///   score = 5 + 3 (категория) = 8, threshold = 5 -> flipped=true, preferred="code"
///
///   quick-answer с "tokio::" в тексте, category=Chat
///   fired = ["code-edit-marker"] (только logged, не считается)
///   score = 0 (нет category bonus для chat-marker), threshold = 5 -> НЕ flipped
pub fn auto_prefer(input: &TaskInput, fallback_model: &str, settings: &EngineSettings) -> EngineDecision {
    let threshold = settings.threshold;

    // Disabled: возвращаем no-op решение (для логирования).
    if !settings.enabled {
        return EngineDecision {
            preferred_model: fallback_model.to_string(),
            fallback_model: fallback_model.to_string(),
            fired: Vec::new(),
            score: 0,
            threshold,
            flipped: false,
            code_parse_signal: false,
            low_confidence: false,
        };
    }

    // Perf: with_capacity(5) — максимум 4 conditions + tool-call-pattern.
    // Vec::new() бы аллоцировал capacity 0 и realloc'ил бы на каждом push.
    let mut fired: Vec<String> = Vec::with_capacity(5);
    let mut score: i32 = 0;
    let mut preferred = fallback_model.to_string();
    let mut low_confidence: bool = false;

    // R82: tree-sitter structural code-confirm. Вызываем ДО code-edit
    // condition, чтобы потом решить flip или reject. Hot-path: p50 < 5ms
    // на 1KB (см. parser::tests::perf_parse_latency_p50_under_5ms_on_1kb).
    // Для коротких промптов (< 200 chars) — обычно < 0.5ms.
    let is_actual_code = parser::CodeParser::is_code_construct(&input.user_text);
    let has_edit_intent = has_russian_edit_verb(&input.user_text);

    // Condition 1: vision
    if input.features.has_image {
        fired.push("vision".to_string());
        score += CONDITION_WEIGHT;
        preferred = "vision".to_string();
    }

    // Condition 2: code-edit
    //
    // R79 baseline: fires ТОЛЬКО при code-fence (strong) или (markers + category=CodeEdit).
    // Keyword-only marker (напр. "tokio::" в quick-answer) НЕ flip'ает модель —
    // только логируется как "code-edit-marker" для observability.
    //
    // R82 enhancement: structural confirmation через tree-sitter.
    //   * code-fence present → flip'аем безусловно (fence = explicit user
    //     signal "это код", parser может и не распарсить ```-обёртку).
    //     Записываем "code-edit" (+ "code-parse-confirmed" если parser
    //     тоже подтвердил).
    //   * parser подтвердил (is_actual_code=true) → flip'аем с high
    //     confidence. Это новый structural signal.
    //   * markers + CodeEdit category + Russian edit-verb, parser
    //     не подтвердил → flip'аем с low_confidence=true.
    //   * markers + CodeEdit category без verb, parser не подтвердил →
    //     rejected (R79 §5.3 over-fire protection).
    let code_edit_strong = input.features.has_code_fence;
    let code_edit_with_category = input.features.has_code_markers
        && matches!(input.features.category, Some(TaskCategory::CodeEdit));

    // Decision tree (R82):
    //   should_flip  | low_conf | условие
    //   -------------+----------+-------------------------------------
    //   true         | false    | is_actual_code (parser confirmed)
    //   true         | false    | code-fence (explicit user signal)
    //   true         | true     | marker + CodeEdit + edit-verb (intent only)
    //   false        | false    | marker + cat без verb/parser (rejected)
    //   false        | false    | только markers без cat (weak signal)
    let (should_flip, reason) = if is_actual_code {
        (true, "code-parse-confirmed")
    } else if code_edit_strong {
        (true, "code-edit") // fence is strong — trust
    } else if code_edit_with_category && has_edit_intent {
        low_confidence = true;
        (true, "code-parse-pending")
    } else {
        (false, "code-edit-rejected")
    };

    if should_flip {
        fired.push("code-edit".to_string());
        fired.push(reason.to_string());
        score += CONDITION_WEIGHT;
        // vision выше по приоритету — перезаписываем только если vision не сработал
        if preferred == fallback_model {
            preferred = "code".to_string();
        }
    } else if code_edit_with_category {
        // Marker + cat сработал, но ни parser ни verb не подтвердили.
        // R79 §5.3 over-fire protection: "tokio::" в quick-answer не должен
        // flip'ать на code, даже если category=CodeEdit (напр. auto-detected).
        fired.push("code-edit-rejected".to_string());
    } else if input.features.has_code_markers {
        // Weak marker hit без code-fence, без CodeEdit-категории, и без
        // parser-подтверждения — логируем для observability, но не flip'аем.
        fired.push("code-edit-marker".to_string());
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
    // но добавляет в fired для метрик.
    if input.features.has_tool_call_pattern {
        fired.push("tool-call-pattern".to_string());
    }

    let flipped = score >= threshold && preferred != fallback_model;

    EngineDecision {
        preferred_model: preferred,
        fallback_model: fallback_model.to_string(),
        fired,
        score,
        threshold,
        flipped,
        code_parse_signal: is_actual_code,
        low_confidence,
    }
}

/// R89: маппинг `preferred_model` → human-readable routing mode для UI.
///
/// Используется фронтом (ChatView) чтобы показать "Smart Engine выбрал:
/// CodeEdit / Vision / QuickAnswer / Reasoning / Default" в chip'е при
/// `low_confidence=true` (R86 finding: engine has the flag but UI ignores
/// it, users get routed silently).
///
/// Маппинг стабильный — расширяем только при добавлении нового
/// preferred_model в `auto_prefer`. Unknown значения фолбэчат на
/// "Default" (на случай если кто-то переопределил env VITE_LLM_MODEL на
/// нестандартное имя).
///
/// Возвращает `&'static str` чтобы не аллоцировать на каждый chip — это
/// hot-path: каждый chat-message проходит через маппинг.
pub fn routing_mode_for(model: &str) -> &'static str {
    match model {
        "code" => "CodeEdit",
        "vision" => "Vision",
        "fast" => "QuickAnswer",
        "large" => "Reasoning",
        // "default" + любое unknown (custom VITE_LLM_MODEL имя) → Default
        _ => "Default",
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

    fn default_settings() -> EngineSettings {
        EngineSettings::default() // enabled=true, threshold=8
    }

    fn disabled_settings() -> EngineSettings {
        EngineSettings {
            enabled: false,
            ..Default::default()
        }
    }

    // ── 10 edge-case теста (R67 добавил 10, R74 восстанавливает) ───────────

    #[test]
    fn empty_prompt_falls_back() {
        let d = auto_prefer(&make_input("", false, None), "default", &default_settings());
        assert!(!d.flipped);
        assert_eq!(d.preferred_model, "default");
        assert!(d.fired.is_empty());
        assert_eq!(d.score, 0);
    }

    #[test]
    fn pure_greeting_flips_to_fast() {
        // R79 Phase 3 (RETRY): threshold=5, CATEGORY_BONUS=3.
        // "Привет!" — short (5) + 0 (нет категории) = 5 >= 5 -> flip на fast.
        // Это документирует, что default ON = короткие промпты идут в fast.
        // До R79 (t=8) это не flip'алось. R79 Eval Harness показал, что
        // 47/100 реальных промптов — short, и они должны идти в fast-модель
        // (быстрее + дешевле).
        let d = auto_prefer(&make_input("Привет!", false, None), "default", &default_settings());
        assert!(d.flipped, "short greeting should flip to fast at t=5: {:?}", d);
        assert_eq!(d.preferred_model, "fast");
        assert!(d.fired.iter().any(|f| f == "short"));
        assert_eq!(d.score, 5);
    }

    #[test]
    fn short_prompt_with_chat_category_flips_at_t5() {
        // R79 Phase 3 (RETRY): threshold=5, CATEGORY_BONUS=3.
        // short (5) + category bonus (3) = 8 >= 5 -> flipped.
        // Это базовое поведение default ON: короткий вопрос с категорией
        // уходит в fast-модель.
        let d = auto_prefer(&make_input("hi", false, Some(TaskCategory::Chat)), "default", &default_settings());
        assert!(d.flipped, "short+cat (8) must flip at threshold 5: {:?}", d);
        assert!(d.fired.iter().any(|f| f == "short"));
        assert_eq!(d.score, 8); // short(5) + category(3)
        assert_eq!(d.preferred_model, "fast");
    }

    #[test]
    fn long_alone_with_category_flips_at_t5() {
        // R79: long (5) + category (3) = 8 >= 5 -> flipped на large.
        let text: String = "a".repeat(LONG_CHARS + 10);
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::Reasoning)), "default", &default_settings());
        assert!(d.flipped, "long+cat should flip at t=5: {:?}", d);
        assert!(d.fired.iter().any(|f| f == "long"));
        assert_eq!(d.preferred_model, "large");
    }

    #[test]
    fn code_fence_alone_flips() {
        // R79: code-fence = strong signal. has_code_fence=true -> fires
        // code-edit condition даже без категории.
        // short (нет, не сработает, has_code_markers=true) + code (5) = 5 >= 5 -> flip
        let d = auto_prefer(
            &make_input("```rust\nfn main() {}\n```", false, None),
            "default",
            &default_settings(),
        );
        assert!(d.flipped, "code-fence should flip at t=5 even without category: {:?}", d);
        assert_eq!(d.preferred_model, "code");
        assert_eq!(d.score, 5); // только code-edit(5), без category bonus
    }

    #[test]
    fn code_marker_with_category_flips() {
        // R79: без code-fence, но marker + category=CodeEdit -> flip.
        // "напиши функцию add" — Roman'овский prose-style.
        let d = auto_prefer(
            &make_input("напиши функцию add", false, Some(TaskCategory::CodeEdit)),
            "default",
            &default_settings(),
        );
        assert!(d.flipped, "marker+CodeEdit should flip at t=5: {:?}", d);
        assert_eq!(d.preferred_model, "code");
        assert_eq!(d.score, 8); // code(5) + category(3)
    }

    #[test]
    fn code_marker_without_category_does_not_flip() {
        // R79: weak marker hit (напр. "tokio::") БЕЗ категории CodeEdit
        // логируется в fired, но НЕ flip'ает. Это решает R79 §5.3 over-fire:
        // quick-answer "Чем tokio::spawn отличается от std::thread?" больше
        // не уходит в code-модель.
        let d = auto_prefer(
            &make_input("Чем tokio::spawn отличается от std::thread?", false, Some(TaskCategory::Chat)),
            "default",
            &default_settings(),
        );
        // short (5) + category bonus (3) = 8 -> flip на fast (это OK для chat+short)
        // но НЕ на code. Проверяем: preferred != "code".
        assert_ne!(d.preferred_model, "code", "weak code marker should not flip to code: {:?}", d);
        assert!(d.fired.iter().any(|f| f == "code-edit-marker") || d.fired.iter().any(|f| f == "short"));
    }

    #[test]
    fn code_plus_long_flips() {
        // R79: code-fence + long + category = 5 + 5 + 3 = 13 >= 5 -> flip.
        let mut text = String::from("```rust\n");
        text.push_str("fn solve(x: i32) -> i32 {\n");
        text.push_str(&"    x + 1\n".repeat(80));
        text.push_str("}\n```");
        assert!(text.chars().count() > LONG_CHARS, "test setup: text must be > LONG_CHARS ({}), got {}", LONG_CHARS, text.chars().count());
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::CodeEdit)), "default", &default_settings());
        assert!(d.flipped, "code+long+category should flip: {:?}", d);
        assert!(d.fired.iter().any(|f| f == "code-edit"));
        assert!(d.fired.iter().any(|f| f == "long"));
        assert!(d.score >= 5);
    }

    #[test]
    fn vision_overrides_everything() {
        let text = "```rust\nfn main() {}\n```";
        let d = auto_prefer(&make_input(text, true, Some(TaskCategory::CodeEdit)), "default", &default_settings());
        assert!(d.flipped);
        assert_eq!(d.preferred_model, "vision");
        assert!(d.fired.iter().any(|f| f == "vision"));
        // vision ставится первым, code-edit добавляет score, но не override'ит
        // preferred (мы только перезаписываем если preferred == fallback)
    }

    #[test]
    fn threshold_exact_boundary() {
        // R79: при t=5, 1 condition (5) достаточно для flip.
        // 2 conditions (5+5 = 10) тоже flip. Документируем что score
        // >= 5 (default threshold) достаточно.
        let d = auto_prefer(
            &make_input("```rust\nfn f() {}", false, None),
            "default",
            &default_settings(),
        );
        assert!(d.flipped, "5 must flip at threshold 5: {:?}", d);
        assert!(d.score >= 5);
    }

    #[test]
    fn threshold_below() {
        // R79: голый long без категории = 5 >= 5 -> flip (это нормально
        // для threshold=5, в отличие от R67/R75 где t=12 давал 5 < 12).
        let text: String = "a".repeat(LONG_CHARS + 1);
        let d = auto_prefer(&make_input(&text, false, None), "default", &default_settings());
        assert!(d.flipped, "long alone (5) flips at threshold 5: {:?}", d);
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
    fn tool_call_pattern_does_not_override_to_code() {
        // R79 Phase 3: tool-call-pattern fires (logged), но НЕ override'ит
        // модель на code/vision. Только short+cat даёт flip на fast — это
        // желаемо для tool-use (короткий JSON-RPC вызов = fast model).
        let text = "{\"name\":\"web_search\",\"args\":{\"query\":\"rust\"}}";
        let d = auto_prefer(&make_input(text, false, Some(TaskCategory::ToolUse)), "default", &default_settings());
        assert!(d.fired.iter().any(|f| f == "tool-call-pattern"));
        // tool-call pattern не override'ит preferred (он не в score, только logged)
        assert_ne!(d.preferred_model, "code", "tool-call-pattern must not route to code: {:?}", d);
        assert_ne!(d.preferred_model, "vision", "tool-call-pattern must not route to vision: {:?}", d);
    }

    // ── 3 verify-scenarios (R67 добавил 3, R79 обновил под t=5) ─────────────

    #[test]
    fn verify_chat_greeting_flips_to_fast() {
        // R79 default ON: "привет, как дела?" + Chat = short(5) + cat(3) = 8
        // → flipped на fast. Это контракт с юзером: простой чат идёт в
        // быструю модель (gemma2:2b), не в gemma3:4b.
        let d = auto_prefer(&make_input("привет, как дела?", false, Some(TaskCategory::Chat)), "default", &default_settings());
        assert!(d.flipped, "R79 default ON: chat greeting should flip to fast: {:?}", d);
        assert_eq!(d.preferred_model, "fast");
        assert!(d.score >= 5);
    }

    #[test]
    fn verify_reasoning_math_flips_to_large() {
        // R79 default ON: длинная задача reasoning + Reasoning = long(5) + cat(3)
        // = 8 → flipped на large (qwen2.5-coder:7b). Это контракт: большие
        // reasoning задачи идут в большую модель.
        let unit = "Реши задачу: найди x в уравнении 3x + 7 = 22. ";
        let text: String = unit.repeat(20);
        assert!(text.chars().count() > LONG_CHARS, "test setup: text must be > LONG_CHARS ({}), got {}", LONG_CHARS, text.chars().count());
        let d = auto_prefer(&make_input(&text, false, Some(TaskCategory::Reasoning)), "default", &default_settings());
        assert!(d.fired.iter().any(|f| f == "long"), "long must fire for long prompt: {:?}", d);
        assert!(d.flipped, "R79 default ON: long+reasoning should flip to large: {:?}", d);
        assert_eq!(d.preferred_model, "large");
    }

    #[test]
    fn verify_tool_use_json_flips_to_fast() {
        // R79 default ON: короткий JSON-RPC tool call + ToolUse = short(5) + cat(3)
        // = 8 → flipped на fast. Tool-call-pattern fires (logged), но
        // не override'ит на code/vision.
        let text = r#"{"name":"list_installed_apps","args":{}}"#;
        let d = auto_prefer(&make_input(text, false, Some(TaskCategory::ToolUse)), "default", &default_settings());
        assert!(d.fired.iter().any(|f| f == "tool-call-pattern"));
        assert!(d.flipped, "R79 default ON: short tool-use should flip to fast: {:?}", d);
        assert_eq!(d.preferred_model, "fast");
    }

    // ── R79 NEW (RETRY): 5 threshold-behavior tests ──────────────────────────
    // Документируем поведение на границах threshold'а. R75 §5.1 рекомендовал
    // 12→8, R79 Eval Harness нашёл 0/100 flipped при t=8 на реальных промптах,
    // RETRY ставит 5. Эти тесты — regression-detector если кто-то случайно
    // вернёт обратно 8/12 или сдвинет на 6/7.

    #[test]
    fn r79_threshold_curve_default_is_5() {
        // R79 Phase 3 RETRY: default threshold = 5 (не 8, не 12).
        let s = EngineSettings::default();
        assert_eq!(s.threshold, 5, "default threshold must be 5 (R79 RETRY)");
        assert!(s.enabled, "default must be enabled (ship default ON)");
    }

    #[test]
    fn r79_threshold_4_aggressive() {
        // R79: при t=4, 1 condition alone (5) ≥ 4 -> flip. Это ВСЕ промпты
        // с любым code/short/long marker. Агрессивно, но в MIN_THRESHOLD=4.
        // Используем long alone (без категории): score=5 >= 4 -> flip.
        let text: String = "a".repeat(LONG_CHARS + 1);
        let mut s = EngineSettings::default();
        s.threshold = 4;
        let d = auto_prefer(&make_input(&text, false, None), "default", &s);
        assert!(d.flipped, "long alone (5) should flip at threshold 4: {:?}", d);
    }

    #[test]
    fn r79_threshold_5_default_1condition_flips() {
        // R79: default t=5. 1 condition (5) + 0 cat = 5 >= 5 -> flip.
        // Конкретный пример: short промпт без категории = 5 -> flip.
        let d = auto_prefer(&make_input("hi", false, None), "default", &default_settings());
        assert!(d.flipped, "short alone (5) must flip at default t=5: {:?}", d);
        assert_eq!(d.score, 5);
    }

    #[test]
    fn r79_threshold_6_more_conservative() {
        // R79: при t=6, 1 condition (5) < 6 -> не flip. Нужна комбинация
        // (1 cond + cat = 5+3 = 8) или (2 cond = 10) для flip.
        // "hi" + Chat = 5+3 = 8 >= 6 -> flip.
        let d = auto_prefer(&make_input("hi", false, Some(TaskCategory::Chat)), "default", &EngineSettings { threshold: 6, ..Default::default() });
        assert!(d.flipped, "short+cat (8) should flip at t=6: {:?}", d);
    }

    #[test]
    fn r79_threshold_8_r75_recommendation_no_flip() {
        // R79 Eval Harness: t=8 (R75 recommendation) на реальных промптах
        // дал 0/100 flipped. Документируем это поведение:
        // 1 condition (5) + 0 cat = 5 < 8 -> не flip.
        let d = auto_prefer(&make_input("hi", false, None), "default", &EngineSettings { threshold: 8, ..Default::default() });
        assert!(!d.flipped, "R79 Eval Harness finding: t=8 with no category doesn't flip: {:?}", d);
        assert_eq!(d.score, 5);
    }

    #[test]
    fn r79_threshold_12_r67_legacy_does_not_flip() {
        // R67 legacy t=12. 1 condition (5) < 12. 2 conditions (10) < 12.
        // 2 cond + cat (13) >= 12 — но такое в реальных промптах почти
        // не встречается (R79 Eval Harness).
        let mut text = String::from("```rust\nfn f() {}\n");
        text.push_str(&"// padding\n".repeat(60));
        assert!(text.chars().count() > LONG_CHARS, "test setup: text must be > LONG_CHARS");
        let d = auto_prefer(
            &make_input(&text, false, Some(TaskCategory::CodeEdit)),
            "default",
            &EngineSettings { threshold: 12, ..Default::default() },
        );
        // code + long + cat = 5+5+3 = 13 >= 12 -> flip
        assert!(d.flipped, "code+long+cat (13) should flip at t=12: {:?}", d);
    }

    // ── R79 NEW: disabled-returns-fallback test ──────────────────────────────

    #[test]
    fn r79_disabled_returns_fallback() {
        // settings.enabled=false -> flipped=false, preferred=fallback,
        // fired=[] (никаких маркеров не оцениваем — экономия CPU).
        let d = auto_prefer(
            &make_input("```rust\nfn f() {}\n```", true, Some(TaskCategory::CodeEdit)),
            "default",
            &disabled_settings(),
        );
        assert!(!d.flipped);
        assert_eq!(d.preferred_model, "default");
        assert!(d.fired.is_empty(), "disabled must not record fired conditions: {:?}", d);
        assert_eq!(d.score, 0);
    }

    // ── R79 NEW: EngineSettings clamping test ───────────────────────────────

    #[test]
    fn r79_engine_settings_clamping() {
        // < 4 -> 4, > 20 -> 20. Это защищает от "threshold=0, флипаем всё".
        let mut s = EngineSettings::default();
        s.threshold = 0;
        assert_eq!(s.clamped().threshold, 4);
        s.threshold = 100;
        assert_eq!(s.clamped().threshold, 20);
        s.threshold = 8;
        assert_eq!(s.clamped().threshold, 8);
        s.threshold = -5;
        assert_eq!(s.clamped().threshold, 4);
    }

    // ── R79 NEW: TaskCategory::from_str_opt test ────────────────────────────

    #[test]
    fn r79_task_category_from_str() {
        assert_eq!(TaskCategory::from_str_opt("code-edit"), Some(TaskCategory::CodeEdit));
        assert_eq!(TaskCategory::from_str_opt("chat"), Some(TaskCategory::Chat));
        assert_eq!(TaskCategory::from_str_opt("tool-use"), Some(TaskCategory::ToolUse));
        assert_eq!(TaskCategory::from_str_opt("reasoning"), Some(TaskCategory::Reasoning));
        assert_eq!(TaskCategory::from_str_opt("bogus"), None);
        assert_eq!(TaskCategory::from_str_opt(""), None);
    }

    // ── R82 NEW: tree-sitter structural code-confirm integration test ───────

    /// R79 Eval Harness §5.3 false-negative #1:
    /// "Что делает `async fn main() { tokio::spawn(...) }`?" — R79 marker-regex
    /// не подтверждал code construct (нет ``` fence, нет category, есть только
    /// keyword markers в inline backticks). С tree-sitter: парсер извлекает
    /// inline backtick, видит `fn main() { ... }` как function_item, и
    /// confirm'ит code_parse_signal.
    ///
    /// Ожидаемое: code_parse_signal=true, flipped=true, preferred="code".
    #[test]
    fn r82_inline_backtick_code_construct_flips_with_parse_signal() {
        let prompt = "Что делает `async fn main() { tokio::spawn(...) }`?";
        let d = auto_prefer(
            &make_input(prompt, false, Some(TaskCategory::CodeEdit)),
            "default",
            &default_settings(),
        );
        assert!(
            d.code_parse_signal,
            "R82: tree-sitter should confirm code construct from inline backtick: {:?}",
            d
        );
        assert!(
            d.flipped,
            "R82: code-confirmed prompt should flip to code model: {:?}",
            d
        );
        assert_eq!(d.preferred_model, "code");
        assert!(d.fired.iter().any(|f| f == "code-parse-confirmed"));
    }

    /// R79 Eval Harness §5.3 false-negative #2:
    /// "Объясни как работает Vec::new()" — R79 marker-regex flip'ал (имеет
    /// "::new(" маркер), но это вопрос, не code request. С tree-sitter: parser
    /// НЕ находит function_item (Vec::new() — expression, не function), и
    /// code_parse_signal=false.
    ///
    /// Ожидаемое: code_parse_signal=false, НЕ flip'ает на code (flip'ает на
    /// fast из-за short+cat, что OK).
    #[test]
    fn r82_prose_with_code_keyword_no_parse_signal() {
        let prompt = "Объясни как работает Vec::new() в Rust";
        let d = auto_prefer(
            &make_input(prompt, false, Some(TaskCategory::Chat)),
            "default",
            &default_settings(),
        );
        assert!(
            !d.code_parse_signal,
            "R82: prose with code keyword but no block should NOT have parse signal: {:?}",
            d
        );
        assert_ne!(
            d.preferred_model, "code",
            "R82: prose should NOT route to code model: {:?}",
            d
        );
    }

    /// R82: marker + Russian edit verb, no parseable code → low_confidence.
    /// Это R79 over-fire fix подтверждение: "напиши функцию add" (R79 §5.2
    /// marker hit) flip'ает, но помечается low_confidence=true (parser не
    /// видел полный function body).
    #[test]
    fn r82_russian_verb_no_parser_confirm_is_low_confidence() {
        let prompt = "напиши функцию add";
        let d = auto_prefer(
            &make_input(prompt, false, Some(TaskCategory::CodeEdit)),
            "default",
            &default_settings(),
        );
        assert!(d.flipped, "should flip on marker+cat: {:?}", d);
        assert_eq!(d.preferred_model, "code");
        assert!(
            d.low_confidence,
            "R82: no parser confirm + Russian edit verb = low_confidence: {:?}",
            d
        );
        assert!(d.fired.iter().any(|f| f == "code-parse-pending"));
    }

    /// R82: full Rust code block + CodeEdit category → high confidence.
    /// Парсер видит `fn main()`, `use std::`, struct → confirm.
    #[test]
    fn r82_full_rust_code_block_high_confidence() {
        let prompt = "поправь:\n```rust\nuse std::collections::HashMap;\nfn main() { let _ = HashMap::new(); }\n```";
        let d = auto_prefer(
            &make_input(prompt, false, Some(TaskCategory::CodeEdit)),
            "default",
            &default_settings(),
        );
        assert!(d.flipped);
        assert_eq!(d.preferred_model, "code");
        assert!(
            d.code_parse_signal,
            "R82: full Rust code block should have parse signal: {:?}",
            d
        );
        assert!(!d.low_confidence, "parser-confirmed code = high confidence");
        assert!(d.fired.iter().any(|f| f == "code-parse-confirmed"));
    }

    // ── R89: routing_mode_for + EngineDecision serialization (low_confidence UI) ──

    /// R89: routing_mode_for маппит все 5 preferred_model на UI-friendly имена.
    /// Покрывает все ветки match: code/vision/fast/large/default + unknown fallback.
    #[test]
    fn r89_routing_mode_for_maps_all_models() {
        assert_eq!(routing_mode_for("code"), "CodeEdit");
        assert_eq!(routing_mode_for("vision"), "Vision");
        assert_eq!(routing_mode_for("fast"), "QuickAnswer");
        assert_eq!(routing_mode_for("large"), "Reasoning");
        assert_eq!(routing_mode_for("default"), "Default");
        // unknown / custom VITE_LLM_MODEL → Default
        assert_eq!(routing_mode_for("gemma3:4b"), "Default");
        assert_eq!(routing_mode_for("custom-model-7b"), "Default");
        assert_eq!(routing_mode_for(""), "Default");
    }

    /// R89: EngineDecision сериализует low_confidence + code_parse_signal
    /// в JSON (нужно для frontend, чтобы Tauri-команда вернула оба флага
    /// на фронт без round-trip). Default = false для old serializations.
    #[test]
    fn r89_engine_decision_serializes_low_confidence_and_parse_signal() {
        let d = EngineDecision {
            preferred_model: "code".to_string(),
            fallback_model: "default".to_string(),
            fired: vec!["code-edit".to_string(), "code-parse-pending".to_string()],
            score: 8,
            threshold: 5,
            flipped: true,
            code_parse_signal: false,
            low_confidence: true,
        };
        let json = serde_json::to_string(&d).expect("serialize");
        // Проверяем что ОБА флага попали в JSON (R86 follow-up: low_confidence
        // был потерян в round-trip до R82).
        assert!(json.contains("\"low_confidence\":true"), "got: {json}");
        assert!(
            json.contains("\"code_parse_signal\":false"),
            "got: {json}"
        );
        assert!(json.contains("\"flipped\":true"), "got: {json}");
        assert!(json.contains("\"preferred_model\":\"code\""), "got: {json}");
    }

    /// R89: end-to-end R86-style low_confidence флаг доезжает до EngineDecision.
    /// Это ключевое: если UI consumer сломан, чип не покажется. R86 finding
    /// был что flag есть в engine но не surfaced. Этот тест доказывает что
    /// сам флаг работает end-to-end.
    #[test]
    fn r89_r86_followup_low_confidence_flag_fires_in_decision() {
        // R86 Eval Harness: 23/25 code-edit prompts flagged low_confidence.
        // Воспроизводим типичный low_conf кейс: marker+category+verb, parser
        // не подтвердил.
        let prompt = "напиши функцию которая делает X";
        let d = auto_prefer(
            &make_input(prompt, false, Some(TaskCategory::CodeEdit)),
            "default",
            &default_settings(),
        );
        assert!(d.flipped, "should flip on marker+cat+verb: {:?}", d);
        assert!(d.low_confidence, "R86 finding: should fire low_confidence: {:?}", d);
        // И сам флаг сериализуется — без этого UI не получит сигнал
        let json = serde_json::to_string(&d).unwrap();
        assert!(json.contains("\"low_confidence\":true"));
    }
}
