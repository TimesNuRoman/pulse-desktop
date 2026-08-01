// R86 — R79 Eval Harness Rust-side runner.
//
// Зачем: существующий `run-eval.ps1` зеркалит R79-логику на PowerShell
// (regex-маркеры, без tree-sitter). Это даёт только R79-baseline числа.
// R82 tree-sitter улучшение НЕ ВИДНО из PS-зеркала. Этот binary напрямую
// дёргает `engine::auto_prefer` с реальным tree-sitter парсером и
// выдаёт настоящие R82 метрики.
//
// Использование:
//   cargo run --release --bin eval_r86 -- <prompts.jsonl> <output_dir> [engine_mode]
//
// engine_mode: baseline | v3-off | v3-on (default v3-on)
//
// Выход:
//   <output_dir>/r86-results-<engine_mode>-<ts>.jsonl
//   <output_dir>/r86-summary-<engine_mode>-<ts>.json

use std::fs;
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::time::Instant;

use pulse_desktop_lib::engine::{
    auto_prefer, extract_features, EngineDecision, EngineSettings, TaskCategory, TaskInput,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
struct Prompt {
    id: String,
    category: String,
    prompt: String,
    expected_mode: String,
    #[serde(default)]
    expected_keywords: Vec<String>,
    #[serde(default)]
    notes: String,
}

#[derive(Debug, Serialize)]
struct ResultRow {
    id: String,
    category: String,
    expected_mode: String,
    prompt_excerpt: String,
    preferred_model: String,
    flipped: bool,
    fired: Vec<String>,
    score: i32,
    threshold: i32,
    code_parse_signal: bool,
    low_confidence: bool,
    has_code_fence: bool,
    has_code_markers: bool,
    char_count: usize,
    expected_routing_pass: bool,
    routing_pass: bool,
    routing_pass_reason: String,
}

#[derive(Debug, Serialize)]
struct Summary {
    generated_at: String,
    engine_mode: String,
    pass_threshold: i32,
    total_prompts: usize,
    by_category: std::collections::BTreeMap<String, CatSummary>,
    flipped_total: usize,
    flipped_rate_pct: f64,
    routing_pass_total: usize,
    routing_pass_rate_pct: f64,
    code_parse_signal_count: usize,
    low_confidence_count: usize,
    condition_hits: std::collections::BTreeMap<String, usize>,
    failures: Vec<String>,
    wall_time_ms: u64,
}

#[derive(Debug, Serialize)]
struct CatSummary {
    n: usize,
    routing_pass: usize,
    flipped: usize,
    preferred_models: std::collections::BTreeMap<String, usize>,
    code_parse_signal: usize,
    low_confidence: usize,
}

fn category_to_taskcat(s: &str) -> Option<TaskCategory> {
    let _ = s;
    None
}

/// Map JSONL `expected_mode` (camelCase: "CodeEdit" | "Chat" | "ToolUse" | "Reasoning")
/// to engine TaskCategory. This is what the engine actually uses for
/// `code_edit_with_category` detection in auto_prefer.
fn expected_mode_to_taskcat(s: &str) -> Option<TaskCategory> {
    match s {
        "CodeEdit" => Some(TaskCategory::CodeEdit),
        "Chat" => Some(TaskCategory::Chat),
        "ToolUse" => Some(TaskCategory::ToolUse),
        "Reasoning" => Some(TaskCategory::Reasoning),
        "code-edit" => Some(TaskCategory::CodeEdit),
        "chat" => Some(TaskCategory::Chat),
        "tool-use" => Some(TaskCategory::ToolUse),
        "reasoning" => Some(TaskCategory::Reasoning),
        _ => None,
    }
}

/// R86 routing expectation table (mirrors R79 scoring-rubric §A.1):
///   habr-search       → default | large | fast
///   code-edit         → code
///   quick-answer      → default | fast
///   tool-call-pattern → default | fast
fn expected_routing(category: &str, preferred: &str) -> (bool, String) {
    let allowed: &[&str] = match category {
        "habr-search" => &["default", "large", "fast"],
        "code-edit" => &["code"],
        "quick-answer" => &["default", "fast"],
        "tool-call-pattern" => &["default", "fast"],
        _ => &["default"],
    };
    let pass = allowed.contains(&preferred);
    let reason = if pass {
        format!("{} in allowed {:?}", preferred, allowed)
    } else {
        format!("{} NOT in allowed {:?}", preferred, allowed)
    };
    (pass, reason)
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 3 {
        eprintln!(
            "Usage: {} <prompts.jsonl> <output_dir> [engine_mode]",
            args.get(0).map(|s| s.as_str()).unwrap_or("eval_r86")
        );
        eprintln!("  engine_mode: baseline | v3-off | v3-on (default v3-on)");
        std::process::exit(1);
    }

    let prompts_path = PathBuf::from(&args[1]);
    let output_dir = PathBuf::from(&args[2]);
    let engine_mode = args
        .get(3)
        .cloned()
        .unwrap_or_else(|| "v3-on".to_string());

    if !prompts_path.exists() {
        eprintln!("prompts.jsonl not found: {}", prompts_path.display());
        std::process::exit(1);
    }
    fs::create_dir_all(&output_dir).expect("create output dir");

    // Engine settings по mode (mirrors R79 PS harness baseline/v3-off/v3-on)
    let (enabled, threshold): (bool, i32) = match engine_mode.as_str() {
        "baseline" => (false, 99), // baseline = Smart Engine выключен
        "v3-off" => (true, 99),    // v3-off = включён, но порог недостижим
        "v3-on" => (true, 5),      // R79 RETRY default
        _ => (true, 5),
    };
    let settings = EngineSettings {
        enabled,
        threshold,
        schema_version: 1,
    };

    // Read prompts
    let file = fs::File::open(&prompts_path).expect("open prompts");
    let reader = std::io::BufReader::new(file);
    let prompts: Vec<Prompt> = reader
        .lines()
        .map_while(|l| l.ok())
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str::<Prompt>(&l).expect("parse JSONL line"))
        .collect();

    eprintln!(
        "[R86] loaded {} prompts from {} (engine_mode={}, threshold={}, enabled={})",
        prompts.len(),
        prompts_path.display(),
        engine_mode,
        threshold,
        enabled
    );

    let ts = chrono_unix();
    let results_path = output_dir.join(format!("r86-results-{}-{}.jsonl", engine_mode, ts));
    let summary_path = output_dir.join(format!("r86-summary-{}-{}.json", engine_mode, ts));

    let mut results_file = BufWriter::new(fs::File::create(&results_path).expect("create results"));

    let mut by_category: std::collections::BTreeMap<String, CatSummary> =
        std::collections::BTreeMap::new();
    let mut condition_hits: std::collections::BTreeMap<String, usize> =
        std::collections::BTreeMap::new();
    let mut flipped_total = 0usize;
    let mut routing_pass_total = 0usize;
    let mut code_parse_signal_count = 0usize;
    let mut low_confidence_count = 0usize;
    let mut failures: Vec<String> = Vec::new();

    let start = Instant::now();
    let mut routing_latencies_us: Vec<u64> = Vec::with_capacity(prompts.len());

    for p in &prompts {
        // Use expected_mode (camelCase) for engine TaskCategory — this is what
        // R79's engine_decide Tauri command does. The JSONL `category` field
        // is the eval bucket (kebab-case) used only for routing expectations.
        let cat = expected_mode_to_taskcat(&p.expected_mode);
        let features = extract_features(&p.prompt, false, cat);
        let input = TaskInput {
            user_text: p.prompt.clone(),
            features,
        };
        let t0 = Instant::now();
        let decision: EngineDecision = auto_prefer(&input, "default", &settings);
        let routing_us = t0.elapsed().as_micros() as u64;
        routing_latencies_us.push(routing_us);

        let (routing_pass, reason) = expected_routing(&p.category, &decision.preferred_model);
        if routing_pass {
            routing_pass_total += 1;
        } else {
            failures.push(format!(
                "{} [{}]: {} (fired={:?}, score={}, code_parse={}, low_conf={})",
                p.id,
                p.category,
                reason,
                decision.fired,
                decision.score,
                decision.code_parse_signal,
                decision.low_confidence
            ));
        }
        if decision.flipped {
            flipped_total += 1;
        }
        if decision.code_parse_signal {
            code_parse_signal_count += 1;
        }
        if decision.low_confidence {
            low_confidence_count += 1;
        }
        for f in &decision.fired {
            *condition_hits.entry(f.clone()).or_insert(0) += 1;
        }

        let cs = by_category
            .entry(p.category.clone())
            .or_insert_with(|| CatSummary {
                n: 0,
                routing_pass: 0,
                flipped: 0,
                preferred_models: std::collections::BTreeMap::new(),
                code_parse_signal: 0,
                low_confidence: 0,
            });
        cs.n += 1;
        if routing_pass {
            cs.routing_pass += 1;
        }
        if decision.flipped {
            cs.flipped += 1;
        }
        if decision.code_parse_signal {
            cs.code_parse_signal += 1;
        }
        if decision.low_confidence {
            cs.low_confidence += 1;
        }
        *cs.preferred_models
            .entry(decision.preferred_model.clone())
            .or_insert(0) += 1;

        let row = ResultRow {
            id: p.id.clone(),
            category: p.category.clone(),
            expected_mode: p.expected_mode.clone(),
            prompt_excerpt: p
                .prompt
                .chars()
                .take(120)
                .collect::<String>()
                .replace('\n', " "),
            preferred_model: decision.preferred_model.clone(),
            flipped: decision.flipped,
            fired: decision.fired.clone(),
            score: decision.score,
            threshold: decision.threshold,
            code_parse_signal: decision.code_parse_signal,
            low_confidence: decision.low_confidence,
            has_code_fence: input.features.has_code_fence,
            has_code_markers: input.features.has_code_markers,
            char_count: input.features.char_count,
            expected_routing_pass: routing_pass,
            routing_pass,
            routing_pass_reason: reason,
        };
        let line = serde_json::to_string(&row).expect("serialize row");
        writeln!(results_file, "{}", line).expect("write row");
    }

    let wall_time_ms = start.elapsed().as_millis() as u64;
    let routing_p50_us = percentile(&mut routing_latencies_us.clone(), 0.50);
    let routing_p95_us = percentile(&mut routing_latencies_us.clone(), 0.95);

    let routing_pass_rate_pct = pct(routing_pass_total, prompts.len());
    let flipped_rate_pct = pct(flipped_total, prompts.len());

    let summary = Summary {
        generated_at: now_iso(),
        engine_mode: engine_mode.clone(),
        pass_threshold: threshold,
        total_prompts: prompts.len(),
        by_category,
        flipped_total,
        flipped_rate_pct,
        routing_pass_total,
        routing_pass_rate_pct,
        code_parse_signal_count,
        low_confidence_count,
        condition_hits,
        failures: failures.into_iter().take(15).collect(),
        wall_time_ms,
    };

    let summary_json = serde_json::to_string_pretty(&summary).expect("serialize summary");
    fs::write(&summary_path, &summary_json).expect("write summary");
    results_file.flush().expect("flush results");

    eprintln!("[R86] results: {}", results_path.display());
    eprintln!("[R86] summary: {}", summary_path.display());
    eprintln!(
        "[R86] routing p50/p95: {}µs / {}µs ({} prompts in {}ms)",
        routing_p50_us,
        routing_p95_us,
        prompts.len(),
        wall_time_ms
    );
    eprintln!(
        "[R86] routing_pass={}/{} ({:.1}%), flipped={} ({:.1}%), code_parse_signal={}, low_confidence={}",
        routing_pass_total,
        prompts.len(),
        routing_pass_rate_pct,
        flipped_total,
        flipped_rate_pct,
        code_parse_signal_count,
        low_confidence_count
    );

    // Print category breakdown to stdout
    println!("\n=== R86 Eval: engine_mode={} (threshold={}) ===", engine_mode, threshold);
    println!(
        "{:<20} {:>4} {:>12} {:>10} {:>14} {:>18}",
        "category", "n", "routing_pass", "flipped", "parse_signal", "preferred_models"
    );
    for (cat, cs) in &summary.by_category {
        let models: Vec<String> = cs
            .preferred_models
            .iter()
            .map(|(k, v)| format!("{}={}", k, v))
            .collect();
        println!(
            "{:<20} {:>4} {:>4}/{} {:>10} {:>14}   [{}]",
            cat,
            cs.n,
            cs.routing_pass,
            cs.n,
            cs.flipped,
            cs.code_parse_signal,
            models.join(", ")
        );
    }
    println!(
        "\nTOTAL: routing_pass={}/{} ({:.1}%), flipped={} ({:.1}%)",
        routing_pass_total, prompts.len(), routing_pass_rate_pct, flipped_total, flipped_rate_pct
    );
    println!("code_parse_signal: {}, low_confidence: {}", code_parse_signal_count, low_confidence_count);
    println!("routing latency p50/p95: {}µs / {}µs", routing_p50_us, routing_p95_us);
}

fn pct(n: usize, total: usize) -> f64 {
    if total == 0 {
        0.0
    } else {
        (n as f64) * 100.0 / (total as f64)
    }
}

fn percentile(values: &mut [u64], p: f64) -> u64 {
    if values.is_empty() {
        return 0;
    }
    values.sort_unstable();
    let idx = ((values.len() - 1) as f64 * p).ceil() as usize;
    values[idx.min(values.len() - 1)]
}

fn chrono_unix() -> u64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn now_iso() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("1970-01-01T00:00:{}Z+epoch_marker", secs)
}
