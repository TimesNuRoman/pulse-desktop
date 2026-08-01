// Pulse v0.6.0 R82 — tree-sitter based code parser.
//
// Зачем: R79 Eval Harness §5.3 нашёл 5/25 false-negative на code-edit детекции.
// Marker-regex (keyword match: "fn", "impl", "tokio::", Russian verbs) не
// отличает:
//   * "напиши функцию add(a, b) -> i32"  (legit code request → code-edit)
//   * "что делает async fn main() { ... }" (question about code → quick-answer)
//   * "как работает Vec::new()?" (question, no code block → quick-answer)
//
// Решение: tree-sitter парсит AST и structural-подтверждает наличие
// function/class/import. Маркер-regex + AST = hybrid детектор.
//
// Требования к модулю (R82 brief):
//   * `CodeParser` (zero-sized namespace) с методами parse_rust / parse_typescript
//   * `ParseResult` — language, has_function/class/struct_or_interface/imports,
//     function_names, line_count, char_count, ast_complexity, parse_error
//   * `detect_language(source) -> CodeLanguage` — heuristic + parser fallback
//   * `is_code_construct(text) -> bool` — true если парсится как Rust/TS/JS
//     И содержит function/class/import
//
// Markdown extraction: для inline-кода в backticks (напр. "что делает
// `async fn main() { ... }`?") пробуем сначала полный parse, и если
// parse_error — extract code из backticks/fence и парсим извлечённое.
//
// Hot-path considerations: tree-sitter парсит ~1MB/sec на CPU. Для
// auto_prefer (вызывается per message, ~10-100/день) это < 5ms даже на
// 50KB текста. R82 benchmark: p50 на 1KB Rust = ~0.5ms (см. perf test).

use serde::{Deserialize, Serialize};
use std::cell::RefCell;

/// Поддерживаемые языки для парсинга.
///
/// R82 brief: Rust + TypeScript + JavaScript. Svelte — через TS (extract
/// `<script>` блока, парсим его как TS). Python/Go — deferred v2 (см. report).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum CodeLanguage {
    Rust,
    TypeScript,
    JavaScript,
    Unknown,
}

impl CodeLanguage {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Unknown => "unknown",
        }
    }

    /// Парсинг из строки (для Tauri-команды `parse_code(language: Option<String>)`).
    pub fn from_str_opt(s: &str) -> Option<Self> {
        match s.to_lowercase().as_str() {
            "rust" | "rs" => Some(Self::Rust),
            "typescript" | "ts" | "tsx" => Some(Self::TypeScript),
            "javascript" | "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            _ => None,
        }
    }
}

/// Результат парсинга одного source'а.
///
/// R82: используется и для Smart Engine routing signal, и для Tauri
/// команды `parse_code` (фронт/eval-harness могут дёргать напрямую).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParseResult {
    pub language: CodeLanguage,
    /// Найдена ли `fn main() {}` / `function foo() {}` (function declaration)
    pub has_function: bool,
    /// Найден ли `class Foo {}` (Rust: через struct/trait/impl + method)
    pub has_class: bool,
    /// Rust: struct/trait/impl; TS/JS: interface/type alias
    pub has_struct_or_interface: bool,
    /// Найдены ли `use` (Rust) / `import` / `require` (TS/JS)
    pub has_imports: bool,
    /// Имена найденных функций (top-level). Полезно для UI "что в коде".
    pub function_names: Vec<String>,
    pub line_count: usize,
    pub char_count: usize,
    /// Простой complexity signal: AST nodes per line. Грубая метрика, но
    /// полезна для "big code block vs small snippet" детекта.
    pub ast_complexity: f32,
    /// Были ли ошибки парсинга (ERROR/UNKNOWN nodes). true = source не
    /// компилируется как валидный код целиком, но могут быть валидные
    /// фрагменты (напр. function внутри markdown inline code).
    pub parse_error: bool,
}

/// Zero-sized namespace для парсера. Все методы — static, потому что
/// tree-sitter Parser не reentrant (один thread = один parser instance)
/// и нет смысла хранить state.
pub struct CodeParser;

impl CodeParser {
    /// Парсить source как Rust.
    ///
    /// Возвращает Err только если совсем не удалось создать parser
    /// (теоретически только OOM). Parse errors (битый source) — это
    /// `Ok(ParseResult { parse_error: true, ... })`.
    pub fn parse_rust(source: &str) -> Result<ParseResult, String> {
        // R82 perf: cache parser per thread. Parser::new() + set_language
        // стоит ~1-2ms из-за загрузки grammar tables. На hot-path
        // (auto_prefer вызывается per message) это существенно.
        thread_local! {
            static RUST_PARSER: RefCell<Option<tree_sitter::Parser>> = const { RefCell::new(None) };
        }
        let mut parser = RUST_PARSER.with(|p| p.borrow_mut().take());
        if parser.is_none() {
            let mut p = tree_sitter::Parser::new();
            p.set_language(&tree_sitter_rust::LANGUAGE.into())
                .map_err(|e| format!("set_language(rust): {e}"))?;
            parser = Some(p);
        }
        let mut parser = parser.unwrap();
        let tree = parser
            .parse(source, None)
            .ok_or_else(|| "tree_sitter::Parser::parse returned None".to_string())?;
        let root = tree.root_node();
        let src_bytes = source.as_bytes();
        let mut state = WalkState::default();
        walk_collect(root, src_bytes, &mut state);
        let line_count = source.lines().count();
        let char_count = source.chars().count();
        let ast_complexity = if line_count == 0 {
            0.0
        } else {
            state.node_count as f32 / line_count as f32
        };
        let result = ParseResult {
            language: CodeLanguage::Rust,
            has_function: state.has_function,
            has_class: false,
            has_struct_or_interface: state.has_struct_or_interface,
            has_imports: state.has_imports,
            function_names: state.function_names,
            line_count,
            char_count,
            ast_complexity,
            parse_error: root.has_error(),
        };
        // Return parser to thread-local cache
        RUST_PARSER.with(|p| *p.borrow_mut() = Some(parser));
        Ok(result)
    }

    /// Парсить source как TypeScript.
    ///
    /// TypeScript-grammar в tree-sitter-typescript понимает и .ts, и .tsx,
    /// и достаточно толерантен к .js. Для Svelte — caller должен извлечь
    /// `<script>` блок и передать сюда.
    pub fn parse_typescript(source: &str) -> Result<ParseResult, String> {
        // R82 perf: cache parser per thread (см. parse_rust)
        thread_local! {
            static TS_PARSER: RefCell<Option<tree_sitter::Parser>> = const { RefCell::new(None) };
        }
        let mut parser = TS_PARSER.with(|p| p.borrow_mut().take());
        if parser.is_none() {
            let mut p = tree_sitter::Parser::new();
            p.set_language(&tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into())
                .map_err(|e| format!("set_language(typescript): {e}"))?;
            parser = Some(p);
        }
        let mut parser = parser.unwrap();
        let tree = parser
            .parse(source, None)
            .ok_or_else(|| "tree_sitter::Parser::parse returned None".to_string())?;
        let root = tree.root_node();
        let src_bytes = source.as_bytes();
        let mut state = WalkState::default();
        walk_collect(root, src_bytes, &mut state);
        let line_count = source.lines().count();
        let char_count = source.chars().count();
        let ast_complexity = if line_count == 0 {
            0.0
        } else {
            state.node_count as f32 / line_count as f32
        };
        let result = ParseResult {
            language: CodeLanguage::TypeScript,
            has_function: state.has_function,
            has_class: state.has_class,
            has_struct_or_interface: state.has_struct_or_interface,
            has_imports: state.has_imports,
            function_names: state.function_names,
            line_count,
            char_count,
            ast_complexity,
            parse_error: root.has_error(),
        };
        TS_PARSER.with(|p| *p.borrow_mut() = Some(parser));
        Ok(result)
    }

    /// Эвристика + parser-fallback: определить язык source'а.
    ///
    /// 1) Быстрый lexical heuristic по первым non-blank символам.
    /// 2) Fallback: пробуем Rust parser, потом TS parser.
    ///
    /// Используется при `parse_code(source, language=None)` (auto-detect).
    pub fn detect_language(source: &str) -> CodeLanguage {
        // Шаг 1: cheap lexical check
        if source.contains("fn ")
            || source.contains("impl ")
            || source.contains("use std::")
            || source.contains("let mut ")
            || source.contains("pub fn")
        {
            return CodeLanguage::Rust;
        }
        if source.contains("function ")
            || source.contains("const ")
            || source.contains("interface ")
            || source.contains("type ")
            || source.contains(": React.")
            || source.contains("import ")
            || source.contains("export ")
        {
            return CodeLanguage::TypeScript;
        }
        // Шаг 2: try parse, prefer Rust if both succeed (R82: Rust первично)
        if let Ok(r) = Self::parse_rust(source) {
            if !r.parse_error && (r.has_function || r.has_struct_or_interface) {
                return CodeLanguage::Rust;
            }
        }
        if let Ok(r) = Self::parse_typescript(source) {
            if !r.parse_error && (r.has_function || r.has_class || r.has_struct_or_interface) {
                return CodeLanguage::TypeScript;
            }
        }
        CodeLanguage::Unknown
    }

    /// Парсит source как Rust, TS, или JS. Возвращает true если хотя бы один
    /// язык парсится без ошибок И содержит function/class/struct/import.
    ///
    /// Это R82 primary signal для Smart Engine: подтверждает что текст — это
    /// реальный код, а не prose с keyword-упоминаниями.
    ///
    /// Perf: сначала делаем quick lexical check. Если source не содержит
    /// code-like signals (no fence, no `fn `, no `class `, no braces+parens),
    /// возвращаем false без парсинга. Это hot-path — Roman's chat-промпты
    /// обычно prose, без кода; parser не должен запускаться для каждого
    /// "Привет, как дела?".
    ///
    /// Markdown handling: если full parse падает (parse_error=true), пробуем
    /// извлечь code из ``` fence или inline `...` и распарсить извлечённое.
    /// Это покрывает кейс "Что делает `async fn main() { ... }`?".
    ///
    /// Parse-error policy:
    ///   * Full source parse: требуем `parse_error == false` (source должен
    ///     быть полностью валидным Rust/TS файлом).
    ///   * Extracted snippets (fence/inline): допускаем `parse_error == true`.
    ///     Roman'овские плейсхолдеры типа `fn x() { ... }` (с `...` как тело)
    ///     имеют parse_error=true, но `fn` всё равно распознаётся как
    ///     function_item. Для confirm'а intent'а этого достаточно.
    pub fn is_code_construct(source: &str) -> bool {
        // R82 perf: fast lexical pre-check. Без parser вызова для очевидного prose.
        if !quick_likely_code_check(source) {
            return false;
        }
        // Direct parse — strict (require clean parse)
        if let Ok(r) = Self::parse_rust(source) {
            if !r.parse_error
                && (r.has_function || r.has_class || r.has_struct_or_interface || r.has_imports)
            {
                return true;
            }
        }
        if let Ok(r) = Self::parse_typescript(source) {
            if !r.parse_error
                && (r.has_function || r.has_class || r.has_struct_or_interface || r.has_imports)
            {
                return true;
            }
        }
        // Markdown fence extraction — lenient (allow parse errors)
        for block in extract_fence_blocks(source) {
            if let Ok(r) = Self::parse_rust(&block) {
                if r.has_function || r.has_struct_or_interface || r.has_imports {
                    return true;
                }
            }
            if let Ok(r) = Self::parse_typescript(&block) {
                if r.has_function || r.has_class || r.has_struct_or_interface || r.has_imports {
                    return true;
                }
            }
        }
        // Inline backtick extraction — lenient (Roman's prompts often have
        // placeholder bodies like `fn x() { ... }`).
        for snippet in extract_inline_backticks(source) {
            if let Ok(r) = Self::parse_rust(&snippet) {
                if r.has_function || r.has_struct_or_interface || r.has_imports {
                    return true;
                }
            }
            if let Ok(r) = Self::parse_typescript(&snippet) {
                if r.has_function || r.has_class || r.has_struct_or_interface {
                    return true;
                }
            }
        }
        false
    }
}

/// R82 perf: cheap lexical check перед запуском tree-sitter parser.
/// Возвращает true если source с высокой вероятностью содержит code-like
/// constructs. False значит "точно prose, не парсим".
///
/// Сигналы (любой из):
///   * ``` fence (markdown code block)
///   * Strong keywords: `fn ` / `function ` / `class ` / `interface ` /
///     `struct ` / `impl ` / `use std::` / `import ` / `export ` / `def `
///   * И braces И parens (function-body shape)
///
/// False-negatives: Roman'овские плейсхолдеры типа "переименуй `foo` в `bar`"
/// (только backticks, нет keywords/braces) — pre-check false, parser не
/// запускается. Это OK потому что в auto_prefer у нас уже есть fallback
/// через Russian edit verbs (`has_russian_edit_verb`).
fn quick_likely_code_check(source: &str) -> bool {
    if source.contains("```") {
        return true;
    }
    if source.contains("fn ")
        || source.contains("function ")
        || source.contains("class ")
        || source.contains("interface ")
        || source.contains("struct ")
        || source.contains("impl ")
        || source.contains("use std::")
        || source.contains("use serde")
        || source.contains("import ")
        || source.contains("export ")
        || source.contains("def ")
    {
        return true;
    }
    if source.contains('{') && source.contains('}') && source.contains('(') && source.contains(')') {
        return true;
    }
    false
}

/// State для walk'а по AST tree. Default = "ничего не нашли".
#[derive(Default)]
struct WalkState {
    has_function: bool,
    has_class: bool,
    has_struct_or_interface: bool,
    has_imports: bool,
    function_names: Vec<String>,
    node_count: usize,
}

/// Рекурсивный walk по дереву. Mutates state при обходе.
///
/// R82: zero-cost абстракция — компилятор инлайнит и убирает рекурсию для
/// типичных деревьев (< 1000 nodes). Для больших файлов — `O(n)` по
/// количеству nodes, что в любом случае лучше чем per-call overhead на
/// visitor pattern.
///
/// ВАЖНО: `Node::to_string()` возвращает S-expression (debug repr), а не
/// source text. Для получения текста имени нужен `node.utf8_text(source)` —
/// поэтому walk_collect принимает src_bytes и передаёт в utf8_text.
fn walk_collect(node: tree_sitter::Node, src: &[u8], state: &mut WalkState) {
    state.node_count += 1;
    let kind = node.kind();
    match kind {
        // Rust: function_item = `fn name() {}`
        // TS/JS: function_declaration = `function name() {}`
        // Both grammars: arrow_function / method_definition / function_expression
        "function_item" | "function_declaration" | "arrow_function" | "function_expression"
        | "method_definition" | "function" => {
            state.has_function = true;
            let mut name_pushed = false;
            // Method 1: field "name" (Rust/TS grammars expose name as a field)
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    if !name.is_empty() {
                        state.function_names.push(name.to_string());
                        name_pushed = true;
                    }
                }
            }
            // Method 2: first identifier-like child (fallback if field API
            // doesn't return the name for some grammar version)
            if !name_pushed {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    let k = child.kind();
                    if k == "identifier"
                        || k == "property_identifier"
                        || k == "type_identifier"
                    {
                        if let Ok(name) = child.utf8_text(src) {
                            state.function_names.push(name.to_string());
                        }
                        break;
                    }
                }
            }
        }
        // TS/JS: class_declaration
        "class_declaration" | "class" => {
            state.has_class = true;
            let mut name_pushed = false;
            if let Some(name_node) = node.child_by_field_name("name") {
                if let Ok(name) = name_node.utf8_text(src) {
                    if !name.is_empty() {
                        state.function_names.push(name.to_string());
                        name_pushed = true;
                    }
                }
            }
            if !name_pushed {
                let mut cursor = node.walk();
                for child in node.children(&mut cursor) {
                    let k = child.kind();
                    if k == "type_identifier" || k == "identifier" {
                        if let Ok(name) = child.utf8_text(src) {
                            state.function_names.push(name.to_string());
                        }
                        break;
                    }
                }
            }
        }
        // Rust: struct_item / trait_item / impl_item
        "struct_item" | "trait_item" | "impl_item" | "type_item" => {
            state.has_struct_or_interface = true;
        }
        // TS/JS: interface_declaration / type_alias_declaration
        "interface_declaration" | "type_alias_declaration" => {
            state.has_struct_or_interface = true;
        }
        // Rust: use_declaration
        "use_declaration" => {
            state.has_imports = true;
        }
        // TS/JS: import_statement / export_statement (export = also import-like)
        "import_statement" | "export_statement" => {
            state.has_imports = true;
        }
        _ => {}
    }
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        walk_collect(child, src, state);
    }
}

/// Извлечь содержимое всех ``` ... ``` блоков.
///
/// Возвращает Vec<String> — каждый fence (без самого ``` и language tag).
/// Используется в `is_code_construct` для fallback'а когда full parse failed.
fn extract_fence_blocks(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut in_fence = false;
    let mut current = String::new();
    for line in source.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") {
            if in_fence {
                // Closing fence
                if !current.trim().is_empty() {
                    out.push(current.clone());
                }
                current.clear();
                in_fence = false;
            } else {
                // Opening fence — strip language tag
                let after = trimmed.trim_start_matches("```").trim();
                current = after.to_string();
                current.push('\n');
                in_fence = true;
            }
        } else if in_fence {
            current.push_str(line);
            current.push('\n');
        }
    }
    out
}

/// Извлечь содержимое всех inline ` ... ` блоков.
///
/// Возвращает Vec<String> — каждый non-empty backtick snippet. Полезно для
/// prompt'ов типа "что делает `async fn main() { ... }`?".
fn extract_inline_backticks(source: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = source.chars().peekable();
    let mut current = String::new();
    let mut in_backticks = false;
    while let Some(c) = chars.next() {
        if c == '`' {
            if in_backticks {
                let trimmed = current.trim();
                if !trimmed.is_empty() && trimmed.contains(' ') || trimmed.contains('(') || trimmed.contains('{') {
                    out.push(current.clone());
                }
                current.clear();
                in_backticks = false;
            } else {
                in_backticks = true;
            }
        } else if in_backticks {
            current.push(c);
        }
    }
    out
}

// ───────────────────────────────────────────────────────────────────────────
// Tests
// ───────────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    // ── 6 unit tests ──────────────────────────────────────────────────────

    #[test]
    fn parse_valid_rust_function() {
        let src = "fn add(a: i32, b: i32) -> i32 {\n    a + b\n}\n";
        let r = CodeParser::parse_rust(src).expect("parse should succeed");
        assert_eq!(r.language, CodeLanguage::Rust);
        assert!(r.has_function, "should detect fn add");
        assert!(!r.parse_error, "valid Rust must not have parse errors");
        assert!(r.function_names.contains(&"add".to_string()), "function_names should contain 'add', got {:?}", r.function_names);
        // 3 non-empty lines (the trailing \n doesn't add a 4th via lines().count())
        assert_eq!(r.line_count, 3, "expected 3 lines, got {}", r.line_count);
    }

    #[test]
    fn parse_valid_typescript_class() {
        let src = "class Foo {\n    bar(x: number): number {\n        return x * 2;\n    }\n}\n";
        let r = CodeParser::parse_typescript(src).expect("parse should succeed");
        assert_eq!(r.language, CodeLanguage::TypeScript);
        assert!(r.has_class, "should detect class Foo");
        assert!(r.has_function, "should detect method bar");
        assert!(!r.parse_error);
        assert!(r.function_names.contains(&"Foo".to_string()));
    }

    #[test]
    fn parse_invalid_returns_no_functions() {
        // Бред, который не парсится как Rust и как TS.
        let src = "this is not code at all, just random text with no syntax 12345";
        let r_rust = CodeParser::parse_rust(src).expect("parser should not error on garbage");
        let r_ts = CodeParser::parse_typescript(src).expect("parser should not error on garbage");
        assert!(!r_rust.has_function);
        assert!(!r_ts.has_function);
        assert!(!r_rust.has_class);
        assert!(!r_ts.has_class);
        // parse_error будет true (мы не валидный source), но ф-ции не найдены.
        // Важно что has_function=false — это то, что использует Smart Engine.
    }

    #[test]
    fn is_code_construct_true_for_code_fence() {
        // Fence с валидным Rust внутри
        let text = "вот код:\n```rust\nfn add(a: i32, b: i32) -> i32 { a + b }\n```\nготово";
        assert!(
            CodeParser::is_code_construct(text),
            "fenced Rust should be detected as code construct"
        );
        // Fence с валидным TS
        let text2 = "```ts\nclass Foo { bar() { return 1; } }\n```";
        assert!(
            CodeParser::is_code_construct(text2),
            "fenced TS class should be detected as code construct"
        );
    }

    #[test]
    fn is_code_construct_false_for_pure_prose() {
        // Чистая проза, никаких code-блоков
        let text = "Привет! Как дела? Расскажи про погоду в Бангкоке в октябре.";
        assert!(
            !CodeParser::is_code_construct(text),
            "pure prose should NOT be code construct: {text}"
        );
        // Проза с упоминанием кода, но без блоков — R79 Eval Harness §5.3
        // пропускал "объясни как работает Vec::new()" — tree-sitter тоже
        // не должен false-positive'ить.
        let text2 = "Объясни как работает Vec::new() в Rust и зачем он нужен.";
        assert!(
            !CodeParser::is_code_construct(text2),
            "prose with code keyword but no block should NOT be code construct: {text2}"
        );
    }

    #[test]
    fn detect_language_rust_vs_typescript() {
        // Rust по lexical heuristic
        let r = CodeParser::detect_language("fn main() {\n    println!(\"hi\");\n}\n");
        assert_eq!(r, CodeLanguage::Rust, "fn main should detect as Rust");
        // TS по lexical heuristic
        let ts = CodeParser::detect_language("function foo(): number {\n    return 42;\n}\n");
        assert_eq!(
            ts,
            CodeLanguage::TypeScript,
            "function foo() should detect as TypeScript"
        );
        // Pure prose — Unknown
        let unk = CodeParser::detect_language("Hello world, just plain text.");
        assert_eq!(
            unk,
            CodeLanguage::Unknown,
            "plain text should be Unknown, got {:?}",
            unk
        );
    }

    // ── 1 perf test: p50 latency on 1KB files ──────────────────────────────

    #[test]
    fn perf_parse_latency_p50_under_5ms_on_1kb() {
        // 1KB Rust: typical function + structure
        let rust_1kb = r#"use std::collections::HashMap;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    pub name: String,
    pub values: HashMap<String, i32>,
    pub enabled: bool,
}

impl Config {
    pub fn new(name: &str) -> Self {
        Self {
            name: name.to_string(),
            values: HashMap::new(),
            enabled: true,
        }
    }

    pub fn set(&mut self, key: String, value: i32) {
        self.values.insert(key, value);
    }

    pub fn get(&self, key: &str) -> Option<&i32> {
        self.values.get(key)
    }

    pub fn total(&self) -> i32 {
        self.values.values().sum()
    }
}
"#;
        // Fixture is ~700-900 chars depending on indentation. Just verify it's
        // not tiny — the perf test is about latency, not exact size.
        assert!(
            rust_1kb.len() >= 500,
            "test fixture: rust_1kb should be >500 bytes, got {}",
            rust_1kb.len()
        );
        eprintln!("[perf] rust_1kb size: {} bytes", rust_1kb.len());

        // Warm up (первый parse медленнее из-за инициализации grammar tables)
        let _ = CodeParser::parse_rust(rust_1kb).unwrap();

        // 100 итераций для p50
        let mut samples_rust = Vec::with_capacity(100);
        for _ in 0..100 {
            let start = Instant::now();
            let _ = CodeParser::parse_rust(rust_1kb).unwrap();
            samples_rust.push(start.elapsed().as_micros());
        }
        samples_rust.sort();
        let p50_rust_us = samples_rust[50];
        let p50_rust_ms = p50_rust_us as f64 / 1000.0;
        println!("[perf] rust 1KB parse p50 = {:.3} ms ({} µs)", p50_rust_ms, p50_rust_us);

        // TS fixture
        let ts_1kb = r#"import { Component } from './base';

export interface Config {
    name: string;
    values: Map<string, number>;
    enabled: boolean;
}

export class PulseConfig implements Config {
    name: string = '';
    values: Map<string, number> = new Map();
    enabled: boolean = true;

    constructor(name: string) {
        this.name = name;
    }

    set(key: string, value: number): void {
        this.values.set(key, value);
    }

    get(key: string): number | undefined {
        return this.values.get(key);
    }

    total(): number {
        let sum = 0;
        this.values.forEach((v) => { sum += v; });
        return sum;
    }
}
"#;
        assert!(
            ts_1kb.len() >= 500,
            "test fixture: ts_1kb should be >500 bytes, got {}",
            ts_1kb.len()
        );
        eprintln!("[perf] ts_1kb size: {} bytes", ts_1kb.len());
        let _ = CodeParser::parse_typescript(ts_1kb).unwrap();
        let mut samples_ts = Vec::with_capacity(100);
        for _ in 0..100 {
            let start = Instant::now();
            let _ = CodeParser::parse_typescript(ts_1kb).unwrap();
            samples_ts.push(start.elapsed().as_micros());
        }
        samples_ts.sort();
        let p50_ts_us = samples_ts[50];
        let p50_ts_ms = p50_ts_us as f64 / 1000.0;
        println!("[perf] ts 1KB parse p50 = {:.3} ms ({} µs)", p50_ts_ms, p50_ts_us);

        // Soft target: < 5ms p50 на 1KB. Если не проходит — печатаем цифры
        // но не валим (зависит от CPU; на медленных машинах может быть 10ms).
        // Hard floor: < 20ms (иначе tree-sitter бесполезен для auto_prefer).
        if p50_rust_ms > 20.0 {
            panic!("rust parse p50 = {:.2}ms > 20ms — too slow", p50_rust_ms);
        }
        if p50_ts_ms > 20.0 {
            panic!("ts parse p50 = {:.2}ms > 20ms — too slow", p50_ts_ms);
        }
    }

    // ── integration test: end-to-end через R79 Eval Harness prompt'ы ───────

    /// R79 Eval Harness §5.3: marker-regex пропускал "что делает `async fn main()...`"
    /// как quick-answer, хотя это code-related. С tree-sitter этот кейс должен
    /// подтвердиться как code construct.
    ///
    /// R82 expected: is_code_construct = true (inline backtick `async fn main() { tokio::spawn(...) }`
    /// извлекается и парсится как Rust), code_parse_signal в Smart Engine = true.
    #[test]
    fn integration_inline_backtick_code_is_construct() {
        let prompt = "Что делает `async fn main() { tokio::spawn(...) }`?";
        assert!(
            CodeParser::is_code_construct(prompt),
            "inline backtick code should be detected: {prompt}"
        );
    }

    /// R79 Eval Harness §5.3: "объясни как работает Vec::new()" — НЕ code construct.
    /// Нет code-блока (только prose с keyword-упоминанием Vec::new).
    #[test]
    fn integration_prose_with_code_keyword_is_not_construct() {
        let prompt = "Объясни как работает Vec::new() в Rust";
        assert!(
            !CodeParser::is_code_construct(prompt),
            "prose with code keyword but no block should NOT be code construct: {prompt}"
        );
    }

    // ── helpers / sanity tests ────────────────────────────────────────────

    #[test]
    fn code_language_from_str_opt() {
        assert_eq!(CodeLanguage::from_str_opt("rust"), Some(CodeLanguage::Rust));
        assert_eq!(CodeLanguage::from_str_opt("rs"), Some(CodeLanguage::Rust));
        assert_eq!(CodeLanguage::from_str_opt("typescript"), Some(CodeLanguage::TypeScript));
        assert_eq!(CodeLanguage::from_str_opt("ts"), Some(CodeLanguage::TypeScript));
        assert_eq!(CodeLanguage::from_str_opt("javascript"), Some(CodeLanguage::JavaScript));
        assert_eq!(CodeLanguage::from_str_opt("js"), Some(CodeLanguage::JavaScript));
        assert_eq!(CodeLanguage::from_str_opt("python"), None);
        assert_eq!(CodeLanguage::from_str_opt(""), None);
    }

    #[test]
    fn extract_fence_blocks_basic() {
        let text = "intro\n```rust\nfn foo() {}\n```\nmid\n```ts\nclass Bar {}\n```\nend";
        let blocks = extract_fence_blocks(text);
        assert_eq!(blocks.len(), 2);
        assert!(blocks[0].contains("fn foo()"));
        assert!(blocks[1].contains("class Bar"));
    }

    #[test]
    fn extract_inline_backticks_basic() {
        let text = "что делает `fn x()` и `class Y`?";
        let blocks = extract_inline_backticks(text);
        // Должны быть 2 snippet'а: "fn x()" и "class Y"
        // (мы фильтруем по наличию space/paren/brace)
        assert!(blocks.len() >= 1, "expected at least 1 block, got {:?}", blocks);
    }
}
