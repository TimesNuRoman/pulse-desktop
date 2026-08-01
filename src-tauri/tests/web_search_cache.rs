// Pulse — cache behavior probe. Live test that hits the same query twice
// in <1s and verifies the second call returns the same backend+items
// without going to upstream (cache hit).

use pulse_desktop_lib::web_search as ws;

#[tokio::test]
#[ignore]
async fn live_cache_hit_on_repeat_query() {
    let q = "Pulse desktop Rust AI".to_string();
    let r1 = ws::web_search(q.clone(), Some(5)).await.expect("first call");
    let r2 = ws::web_search(q.clone(), Some(5)).await.expect("second call");
    println!("[live] r1.backend={} items={}", r1.backend, r1.items.len());
    println!("[live] r2.backend={} items={}", r2.backend, r2.items.len());
    // Если первый вернул непусто — второй ОБЯЗАН совпасть (cache hit).
    // Если первый вернул пусто — не проверяем, т.к. пустое не кэшируется.
    if !r1.items.is_empty() {
        assert_eq!(r1.backend, r2.backend, "cache should preserve backend");
        assert_eq!(r1.items.len(), r2.items.len(), "cache should preserve items");
        assert_eq!(r1.items[0].url, r2.items[0].url, "cache first URL must match");
    }
}
