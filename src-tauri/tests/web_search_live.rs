// Pulse — live smoke test for web_search fallback chain.
//
// Не запускается по умолчанию (#[ignore]) — требует сети и валит CI на flaky
// upstream. Запускать руками: `cargo test --test web_search_live -- --ignored
// --nocapture`. Логи покажут, что вернули DDG HTML / DDG Lite / Wikipedia на
// реальные запросы. Используется при аудите search-цепочки (R-extra / R75+).

use pulse_desktop_lib::web_search as ws;

#[tokio::test]
#[ignore]
async fn live_ddg_html_rust_release() {
    let r = ws::web_search("Rust 1.83 release".to_string(), Some(5)).await;
    println!("[live] ddg-html rust 1.83 → {:#?}", r);
}

#[tokio::test]
#[ignore]
async fn live_ddg_lite_when_html_blocks() {
    // Типичный anti-bot триггер: "что такое" + cyrillic
    let r = ws::web_search("что такое SVE инструкции".to_string(), Some(5)).await;
    println!("[live] chain SVE → {:#?}", r);
}

#[tokio::test]
#[ignore]
async fn live_wikipedia_factual() {
    let r = ws::web_search("Rust programming language".to_string(), Some(3)).await;
    println!("[live] wikipedia rust → {:#?}", r);
}
