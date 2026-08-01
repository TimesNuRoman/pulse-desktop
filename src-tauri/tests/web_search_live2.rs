// Pulse — second batch of live probes to nail down the cyrillic gap.

use pulse_desktop_lib::web_search as ws;

#[tokio::test]
#[ignore]
async fn live_pure_cyrillic() {
    // Чисто кириллический запрос — должен попасть в ru.wikipedia
    let r = ws::web_search("Брестский государственный университет".to_string(), Some(5)).await;
    println!("[live] pure-cyrillic Brest → {:#?}", r);
}

#[tokio::test]
#[ignore]
async fn live_cyrillic_with_latin() {
    // Смешанный — "SVE инструкции" может выпасть из ru.opensearch
    let r = ws::web_search("SVE инструкции".to_string(), Some(5)).await;
    println!("[live] mixed SVE ru → {:#?}", r);
}

#[tokio::test]
#[ignore]
async fn live_english_only_factual() {
    let r = ws::web_search("ARM SVE instructions".to_string(), Some(5)).await;
    println!("[live] en SVE → {:#?}", r);
}

#[tokio::test]
#[ignore]
async fn live_cyrillic_nonsense() {
    // Должно вернуть offline=true
    let r = ws::web_search("ыфваываываыва ываыва ыва".to_string(), Some(3)).await;
    println!("[live] cyrillic-gibberish → {:#?}", r);
}
