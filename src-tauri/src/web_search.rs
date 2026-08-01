// Pulse — web search (general-purpose).
//
// Frontend вызывает `invoke('web_search', { query, limit })` после эвристики
// `shouldWebSearch` (см. web/src/llm/tools.ts). Внутри — fallback'ы:
//
//   1) DuckDuckGo HTML   (https://html.duckduckgo.com/html/?q=...)
//   2) DuckDuckGo Lite   (https://lite.duckduckgo.com/lite/?q=...)
//   3) Wikipedia REST    (для "что такое X", "кто такой Y")
//   4) DDG Instant API   (https://api.duckduckgo.com/?q=...&format=json,
//                         официальный JSON endpoint без anti-bot)
//
// На каждом шаге: парсим, если получили ≥1 item — возвращаем сразу. Иначе
// идём к следующему. Если все провалились — graceful degradation:
// items=[], offline=true, error=Some(...).
//
// Повторные запросы с тем же query+limit в течение 60 сек обслуживаются
// из in-process LRU-кэша (см. `cache_get/cache_put` ниже) — ChatView
// может вызывать webSearch на каждое сообщение, не нужно каждый раз
// молотить DDG/Wikipedia. Кэшируем только успешные ответы с items.
//
// DDG отдаёт ссылки как редиректы `//duckduckgo.com/l/?uddg=ENCODED&...` —
// раскручиваем через `unwrap_ddg_url` (через `urlencoding`, без новых крейтов).

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchItem {
    pub title: String,
    pub url: String,
    pub snippet: String,
    /// "general" | "wikipedia" — помогает UI и промпту LLM.
    pub source: String,
    /// Человекочитаемое имя сайта: "Habr", "Reddit", "StackOverflow"…
    pub site_name: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct WebSearchResult {
    pub query: String,
    /// Какой backend реально ответил: "ddg-html" | "ddg-lite" | "wikipedia" | "none".
    pub backend: String,
    pub total: u32,
    pub items: Vec<SearchItem>,
    pub offline: bool,
    pub error: Option<String>,
}

const SNIPPET_MAX_CHARS: usize = 220;
const WEB_SEARCH_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
     (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/// TTL in-process кэша web_search: 60 сек. ChatView может дёргать
/// webSearch на каждое сообщение, при этом повторяющиеся ask'и (юзер
/// нажал Enter дважды, или LLM гонит один и тот же вопрос в цикле)
/// не должны молотить DDG/Wikipedia.
const CACHE_TTL_SECS: u64 = 60;
/// Cap записей. LRU-вытеснение при переполнении. 32 — практический
/// потолок для одной сессии.
const CACHE_MAX_ENTRIES: usize = 32;

// ─── In-process LRU cache (no async, std-only) ─────────────────────────────
//
// Хранит WebSearchResult по ключу `query:limit` (lowercase, trim). На miss
// вызывающий делает внешний запрос и кладёт в кэш через cache_put.
// Ошибки (offline=true) НЕ кэшируем — пусть следующий запрос попробует
// заново (upstream мог починиться).
use std::collections::HashMap;
use std::sync::Mutex;
use std::time::Instant;

type CacheEntry = (Instant, WebSearchResult);

static CACHE: Mutex<Option<HashMap<String, CacheEntry>>> = Mutex::new(None);

fn cache_ensure() -> std::sync::MutexGuard<'static, Option<HashMap<String, CacheEntry>>> {
    let mut g = CACHE.lock().expect("web_search cache poisoned");
    if g.is_none() {
        *g = Some(HashMap::new());
    }
    g
}

fn cache_key(query: &str, limit: usize) -> String {
    format!("{}:{}", query.trim().to_lowercase(), limit)
}

/// Возвращаем копию из кэша, если она свежая.
fn cache_get(key: &str) -> Option<WebSearchResult> {
    let g = cache_ensure();
    let map = g.as_ref().expect("cache ensured");
    if let Some((at, res)) = map.get(key) {
        if at.elapsed().as_secs() < CACHE_TTL_SECS {
            return Some(res.clone());
        }
    }
    None
}

/// Кладём успешный (items > 0) результат в кэш. На overflow — LRU-вытеснение
/// по самому старому `at`.
fn cache_put(key: String, res: WebSearchResult) {
    // Не кэшируем «пустые» ответы — пусть следующий запрос снова попробует upstream.
    if res.items.is_empty() {
        return;
    }
    let mut g = cache_ensure();
    let map = g.as_mut().expect("cache ensured");
    if map.len() >= CACHE_MAX_ENTRIES {
        // Найти самый старый entry и удалить.
        if let Some(oldest_key) = map
            .iter()
            .min_by_key(|(_, (at, _))| *at)
            .map(|(k, _)| k.clone())
        {
            map.remove(&oldest_key);
        }
    }
    map.insert(key, (Instant::now(), res));
}

/// Нормализуем URL для дедупа: scheme+host lower, остальное — как есть.
/// `https://en.wikipedia.org/wiki/Rust_(programming_language)` и
/// `https://EN.Wikipedia.org/wiki/Rust_(programming_language)` →
/// один и тот же ключ.
fn url_dedup_key(url: &str) -> String {
    let lower = url.to_lowercase();
    // Отрезаем стандартный трекинг (utm_* и `#fragment`).
    let no_utm = if let Some(idx) = lower.find("utm_") {
        // ищем "&" перед "utm_" — безопасно рубим всё, что идёт дальше
        let cut = lower[..idx]
            .trim_end_matches(|c: char| c == '?' || c == '&')
            .to_string();
        cut
    } else {
        lower
    };
    let no_frag = no_utm.split('#').next().unwrap_or(&no_utm).to_string();
    no_frag
}

/// Дедуп по URL: первый item с данным URL побеждает (сохраняем порядок).
/// Применяется к результату одного backend'а ДО truncate(limit), чтобы
/// `total` отражал «сколько уникальных», а не «сколько уникальных + дублей».
fn dedup_by_url(items: Vec<SearchItem>) -> Vec<SearchItem> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for it in items {
        let key = url_dedup_key(&it.url);
        if key.is_empty() {
            continue;
        }
        if seen.insert(key) {
            out.push(it);
        }
    }
    out
}

/// Классифицируем URL по host → (source_tag, site_name).
/// Используется для badge'а в UI и для подсказки LLM, откуда факт.
fn classify_source(url: &str) -> (&'static str, &'static str) {
    let host = url
        .split_once("://")
        .map(|(_, r)| r)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or("")
        .to_lowercase();
    if host.contains("habr.com") {
        return ("general", "Habr");
    }
    if host.contains("reddit.com") {
        return ("general", "Reddit");
    }
    if host.contains("stackoverflow.com") {
        return ("general", "StackOverflow");
    }
    if host.contains("github.com") {
        return ("general", "GitHub");
    }
    if host.contains("wikipedia.org") {
        return ("wikipedia", "Wikipedia");
    }
    if host.contains("blog.rust-lang.org") {
        return ("general", "Rust Blog");
    }
    if host.ends_with(".go.dev") || host.contains("golang.org") {
        return ("general", "Go Blog");
    }
    if host.contains("developer.mozilla.org") || host == "mdn.io" {
        return ("general", "MDN");
    }
    ("general", "Web")
}

/// Раскручиваем DDG-редирект. На входе:
///   - "//duckduckgo.com/l/?uddg=ENCODED&..." → возвращаем декодированный URL
///   - уже прямой URL → возвращаем как есть
///   - относительный путь → считаем https://...
fn unwrap_ddg_url(href: &str) -> String {
    let h = href.trim_start_matches('/');
    if let Some(idx) = h.find("uddg=") {
        let after = &h[idx + 5..];
        let end = after.find('&').unwrap_or(after.len());
        let encoded = &after[..end];
        if let Ok(decoded) = urlencoding::decode(encoded) {
            let s = decoded.into_owned();
            if !s.is_empty() {
                return s;
            }
        }
    }
    if h.starts_with("http://") || h.starts_with("https://") {
        h.to_string()
    } else if h.starts_with("//") {
        format!("https:{}", h)
    } else if h.is_empty() {
        String::new()
    } else {
        format!("https://{}", h)
    }
}

/// Схлопываем whitespace и режем до SNIPPET_MAX_CHARS (по char-ам, не байтам —
/// важно для кириллицы и эмодзи).
fn trim_snippet(s: &str) -> String {
    let cleaned: String = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if cleaned.chars().count() > SNIPPET_MAX_CHARS {
        let mut out: String = cleaned.chars().take(SNIPPET_MAX_CHARS).collect();
        out.push('…');
        out
    } else {
        cleaned
    }
}

fn parse_ddg_html(html: &str) -> Vec<SearchItem> {
    use scraper::{Html, Selector};
    let doc = Html::parse_document(html);
    let Ok(sel_result) = Selector::parse(".result") else {
        return vec![];
    };
    let Ok(sel_a) = Selector::parse(".result__a") else {
        return vec![];
    };
    let Ok(sel_snippet) = Selector::parse(".result__snippet") else {
        return vec![];
    };

    let mut out = Vec::new();
    for r in doc.select(&sel_result) {
        let Some(a) = r.select(&sel_a).next() else {
            continue;
        };
        let title = a.text().collect::<Vec<_>>().join(" ").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let raw_href = a.value().attr("href").unwrap_or("").to_string();
        let url = unwrap_ddg_url(&raw_href);
        if url.is_empty() || url.contains("duckduckgo.com") {
            continue;
        }
        let snippet = r
            .select(&sel_snippet)
            .next()
            .map(|s| s.text().collect::<Vec<_>>().join(" "))
            .unwrap_or_default();
        let (source_tag, site_name) = classify_source(&url);
        out.push(SearchItem {
            title,
            url,
            snippet: trim_snippet(&snippet),
            source: source_tag.to_string(),
            site_name: site_name.to_string(),
        });
    }
    out
}

fn parse_ddg_lite(html: &str) -> Vec<SearchItem> {
    use scraper::{ElementRef, Html, Selector};
    let doc = Html::parse_document(html);
    // DDG Lite — табличная вёрстка, ссылки с классом result-link (если есть);
    // fallback — любой <a> внутри <td class="result-link">.
    let sel_link = Selector::parse("a.result-link")
        .or_else(|_| Selector::parse(".result-link a"))
        .unwrap_or_else(|_| Selector::parse("a").unwrap());
    let sel_td = Selector::parse("td").unwrap();

    let mut out = Vec::new();
    for a in doc.select(&sel_link) {
        let title = a.text().collect::<Vec<_>>().join(" ").trim().to_string();
        if title.is_empty() {
            continue;
        }
        let raw_href = a.value().attr("href").unwrap_or("").to_string();
        let url = unwrap_ddg_url(&raw_href);
        if url.is_empty() || url.contains("duckduckgo.com") {
            continue;
        }
        // snippet — вторая <td> в родительском <tr> (DDG Lite кладёт результат
        // в две ячейки: title + snippet). parent() возвращает NodeRef, поэтому
        // заворачиваем через ElementRef::wrap.
        let snippet = a
            .parent()
            .and_then(|td| td.parent()) // <tr>
            .and_then(ElementRef::wrap)
            .map(|tr| {
                let tds: Vec<ElementRef> = tr.select(&sel_td).collect();
                // Берём <td> которая не содержит наш title-anchor
                tds.into_iter()
                    .find(|td| !td.select(&sel_link).any(|inner| inner == a))
                    .map(|td| td.text().collect::<Vec<_>>().join(" "))
                    .unwrap_or_default()
            })
            .unwrap_or_default();
        let (source_tag, site_name) = classify_source(&url);
        out.push(SearchItem {
            title,
            url,
            snippet: trim_snippet(&snippet),
            source: source_tag.to_string(),
            site_name: site_name.to_string(),
        });
    }
    out
}

async fn try_ddg_html(query: &str, client: &reqwest::Client) -> Result<Vec<SearchItem>, String> {
    let url = format!(
        "https://html.duckduckgo.com/html/?q={}",
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", WEB_SEARCH_UA)
        .header("Accept-Language", "en-US,en;q=0.9,ru;q=0.8")
        .send()
        .await
        .map_err(|e| format!("ddg-html: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ddg-html: HTTP {}", resp.status()));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("ddg-html: body: {e}"))?;
    Ok(dedup_by_url(parse_ddg_html(&html)))
}

async fn try_ddg_lite(query: &str, client: &reqwest::Client) -> Result<Vec<SearchItem>, String> {
    let url = format!(
        "https://lite.duckduckgo.com/lite/?q={}",
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", WEB_SEARCH_UA)
        .send()
        .await
        .map_err(|e| format!("ddg-lite: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ddg-lite: HTTP {}", resp.status()));
    }
    let html = resp
        .text()
        .await
        .map_err(|e| format!("ddg-lite: body: {e}"))?;
    Ok(dedup_by_url(parse_ddg_lite(&html)))
}

async fn try_wikipedia(query: &str, client: &reqwest::Client) -> Result<Vec<SearchItem>, String> {
    // Lang: ru если есть кириллица, иначе en.
    let primary = if query.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)) {
        "ru"
    } else {
        "en"
    };
    // OpenSearch API: [query, [titles], [descs], [urls]]
    let url = format!(
        "https://{}.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search={}",
        primary,
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", WEB_SEARCH_UA)
        .send()
        .await
        .map_err(|e| format!("wikipedia[{primary}]: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("wikipedia[{primary}]: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("wikipedia[{primary}]: json: {e}"))?;
    let titles = json
        .get(1)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let descs = json
        .get(2)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let urls = json
        .get(3)
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let mut out = Vec::new();
    let mut needs_excerpt = false;
    for (i, title_val) in titles.iter().enumerate() {
        let title = title_val.as_str().unwrap_or("").to_string();
        if title.is_empty() {
            continue;
        }
        let desc = descs
            .get(i)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if desc.is_empty() {
            // ru.wikipedia (и иногда en) отдаёт пустые descriptions на
            // opensearch — дозапросим `extracts` батчем ниже.
            needs_excerpt = true;
        }
        let url = urls
            .get(i)
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if url.is_empty() {
            continue;
        }
        out.push(SearchItem {
            title,
            url,
            snippet: trim_snippet(&desc),
            source: "wikipedia".to_string(),
            site_name: "Wikipedia".to_string(),
        });
    }
    if needs_excerpt && !out.is_empty() {
        // Дозапрос: `action=query&prop=extracts&exintro=1&explaintext=1`
        // даёт первое предложение (до ~500 символов) для батча titles.
        let titles_param: Vec<String> =
            out.iter().map(|it| it.title.clone()).collect();
        let url = format!(
            "https://{}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&format=json&titles={}",
            primary,
            urlencoding::encode(&titles_param.join("|"))
        );
        if let Ok(resp) = client.get(&url).header("User-Agent", WEB_SEARCH_UA).send().await {
            if let Ok(j) = resp.json::<serde_json::Value>().await {
                if let Some(pages) = j.get("query").and_then(|q| q.get("pages")).and_then(|p| p.as_object()) {
                    // Pages идут как { "12345": { title, extract, ... }, ... } — индексируем по title.
                    let mut by_title: std::collections::HashMap<String, String> =
                        std::collections::HashMap::new();
                    for (_id, page) in pages {
                        let t = page.get("title").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let e = page.get("extract").and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if !t.is_empty() && !e.is_empty() {
                            by_title.insert(t, e);
                        }
                    }
                    for it in &mut out {
                        if it.snippet.is_empty() {
                            if let Some(ex) = by_title.get(&it.title) {
                                it.snippet = trim_snippet(ex);
                            }
                        }
                    }
                }
            }
        }
    }
    // Если primary-lang вернул пусто и в запросе есть латиница — попробуем
    // вторую локаль. Типичный кейс: "SVE инструкции" — на ru.wikipedia
    // opensearch 0 совпадений, а на en.wikipedia — есть.
    if out.is_empty() {
        let secondary = if primary == "ru" { "en" } else { "ru" };
        // Не дёргаем en если в запросе НЕТ латиницы — бессмысленно.
        if secondary == "en" && !query_has_latin(query) {
            return Ok(out);
        }
        // Аналогично для ru.
        if secondary == "ru" && !query.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)) {
            return Ok(out);
        }
        let url = format!(
            "https://{}.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search={}",
            secondary,
            urlencoding::encode(query)
        );
        if let Ok(resp) = client.get(&url).header("User-Agent", WEB_SEARCH_UA).send().await {
            if resp.status().is_success() {
                if let Ok(json) = resp.json::<serde_json::Value>().await {
                    let titles = json.get(1).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let descs = json.get(2).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    let urls = json.get(3).and_then(|v| v.as_array()).cloned().unwrap_or_default();
                    for (i, title_val) in titles.iter().enumerate() {
                        let title = title_val.as_str().unwrap_or("").to_string();
                        if title.is_empty() { continue; }
                        let desc = descs.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        let url = urls.get(i).and_then(|v| v.as_str()).unwrap_or("").to_string();
                        if url.is_empty() { continue; }
                        out.push(SearchItem {
                            title,
                            url,
                            snippet: trim_snippet(&desc),
                            source: "wikipedia".to_string(),
                            site_name: "Wikipedia".to_string(),
                        });
                    }
                }
            }
        }
    }
    Ok(dedup_by_url(out))
}

/// True если в строке есть хотя бы один ASCII-латинский символ (A-Z / a-z).
/// Используется для решения: «есть ли смысл пробовать en.wikipedia при пустом
/// ответе primary (ru)» — для чисто-кириллических запросов en-фоллбэк
/// бесполезен (Wikipedia не транслитерирует).
fn query_has_latin(s: &str) -> bool {
    s.chars().any(|c| c.is_ascii_alphabetic())
}

/// Общий веб-поиск с тремя fallback'ами. Frontend вызывает
/// `invoke('web_search', { query, limit })` после эвристики `shouldWebSearch`.
/// На пустой query — graceful error, не паникуем.
#[tauri::command]
pub async fn web_search(query: String, limit: Option<u32>) -> Result<WebSearchResult, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(WebSearchResult {
            query: String::new(),
            backend: "none".to_string(),
            total: 0,
            items: vec![],
            offline: false,
            error: Some("empty query".to_string()),
        });
    }
    let limit = limit.unwrap_or(8).min(20) as usize;

    // In-process cache: повторный запрос того же query+limit в течение 60 сек
    // обслуживаем без обращения к upstream. ChatView может звать webSearch на
    // каждое сообщение — без кэша это легко 5+ req/sec на DDG при активной
    // беседе, что быстро приводит к anti-bot.
    let key = cache_key(&query, limit);
    if let Some(cached) = cache_get(&key) {
        return Ok(cached);
    }

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // Один финальный return — чтобы не дублировать cache_put в каждой ветке.
    let result: WebSearchResult;

    // 1) DDG HTML — основной backend
    match try_ddg_html(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            result = WebSearchResult {
                query: query.clone(),
                backend: "ddg-html".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            };
            cache_put(key, result.clone());
            return Ok(result);
        }
        Ok(_) => {} // пусто — пробуем lite
        Err(e) => eprintln!("[pulse] web_search ddg-html failed: {e}"),
    }

    // 2) DDG Lite — полегче HTML, иногда работает когда HTML блочит
    match try_ddg_lite(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            result = WebSearchResult {
                query: query.clone(),
                backend: "ddg-lite".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            };
            cache_put(key, result.clone());
            return Ok(result);
        }
        Ok(_) => {}
        Err(e) => eprintln!("[pulse] web_search ddg-lite failed: {e}"),
    }

    // 3) Wikipedia — для factual ("что такое X", "кто такой Y")
    match try_wikipedia(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            result = WebSearchResult {
                query: query.clone(),
                backend: "wikipedia".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            };
            cache_put(key, result.clone());
            return Ok(result);
        }
        Ok(_) => {}
        Err(e) => eprintln!("[pulse] web_search wikipedia failed: {e}"),
    }

    // 4) DDG Instant Answer API — официальный JSON-endpoint без anti-bot.
    // Возвращает curated abstract + RelatedTopics. Часто пусто, но для
    // популярных терминов («Rust programming language», «SVE instructions»)
    // выдаёт готовый abstract с описанием. Это последний шанс перед offline.
    match try_ddg_instant(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            result = WebSearchResult {
                query: query.clone(),
                backend: "ddg-instant".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            };
            cache_put(key, result.clone());
            return Ok(result);
        }
        Ok(_) => {}
        Err(e) => eprintln!("[pulse] web_search ddg-instant failed: {e}"),
    }

    // Все четыре провалились или вернули пусто
    Ok(WebSearchResult {
        query,
        backend: "none".to_string(),
        total: 0,
        items: vec![],
        offline: true,
        error: Some(
            "Все поисковики (DDG HTML, DDG Lite, Wikipedia, DDG Instant) вернули пусто или недоступны. Проверь интернет."
                .to_string(),
        ),
    })
}

/// Официальный DuckDuckGo Instant Answer API: `api.duckduckgo.com`.
/// Без anti-bot (это и есть «API»), без browser-like User-Agent.
/// Возвращает JSON: { Abstract, AbstractURL, RelatedTopics: [{Text, FirstURL}, ...] }.
async fn try_ddg_instant(query: &str, client: &reqwest::Client) -> Result<Vec<SearchItem>, String> {
    let url = format!(
        "https://api.duckduckgo.com/?q={}&format=json&no_html=1&skip_disambig=1&limit=10",
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", WEB_SEARCH_UA)
        .send()
        .await
        .map_err(|e| format!("ddg-instant: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("ddg-instant: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("ddg-instant: json: {e}"))?;
    let mut out = Vec::new();
    // 1) Abstract (top-level, если есть)
    if let (Some(abstract_txt), Some(abstract_url)) = (
        json.get("Abstract").and_then(|v| v.as_str()),
        json.get("AbstractURL").and_then(|v| v.as_str()),
    ) {
        if !abstract_txt.is_empty() && !abstract_url.is_empty() {
            let title = json
                .get("Heading")
                .and_then(|v| v.as_str())
                .unwrap_or(query)
                .to_string();
            out.push(SearchItem {
                title: title.clone(),
                url: abstract_url.to_string(),
                snippet: trim_snippet(abstract_txt),
                source: "general".to_string(),
                site_name: "DuckDuckGo".to_string(),
            });
        }
    }
    // 2) RelatedTopics — плоский массив или вложенные группы.
    if let Some(rt) = json.get("RelatedTopics").and_then(|v| v.as_array()) {
        for item in rt {
            // Некоторые RelatedTopics — «groups» с вложенными Topics.
            if let Some(topics) = item.get("Topics").and_then(|v| v.as_array()) {
                for nested in topics {
                    if let Some(p) = parse_ddg_instant_topic(nested) {
                        out.push(p);
                    }
                }
                continue;
            }
            if let Some(p) = parse_ddg_instant_topic(item) {
                out.push(p);
            }
        }
    }
    Ok(dedup_by_url(out))
}

fn parse_ddg_instant_topic(v: &serde_json::Value) -> Option<SearchItem> {
    let text = v.get("Text")?.as_str()?.to_string();
    let url = v.get("FirstURL")?.as_str()?.to_string();
    if text.is_empty() || url.is_empty() {
        return None;
    }
    // URL у DDG-IA содержит redirect `//duckduckgo.com/?q=...` — раскрутим
    // до исходного, если получится достать ?q=...&... (-> сам поисковый
    // запрос, а не «настоящая» страница). Нам ОК оставить как redirect —
    // UI всё равно открывает через `target="_blank"`, и редирект на DDG
    // приемлем. Заголовок = text до первого перевода строки/точки.
    let title = text
        .split('\n')
        .next()
        .unwrap_or(&text)
        .split(". ")
        .next()
        .unwrap_or(&text)
        .chars()
        .take(120)
        .collect::<String>();
    let (source_tag, site_name) = classify_source(&url);
    Some(SearchItem {
        title: if title.is_empty() { text.clone() } else { title },
        url,
        snippet: trim_snippet(&text),
        source: source_tag.to_string(),
        site_name: site_name.to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unwrap_ddg_redirect_decodes_uddg() {
        let href = "//duckduckgo.com/l/?uddg=https%3A%2F%2Fblog.rust-lang.org%2F2024%2F11%2F26%2FRust-1.83.0.html&kl=us-en";
        assert_eq!(
            unwrap_ddg_url(href),
            "https://blog.rust-lang.org/2024/11/26/Rust-1.83.0.html"
        );
    }

    #[test]
    fn unwrap_ddg_passthrough_https() {
        assert_eq!(
            unwrap_ddg_url("https://example.com/path"),
            "https://example.com/path"
        );
    }

    #[test]
    fn unwrap_ddg_passthrough_protocol_relative() {
        assert_eq!(
            unwrap_ddg_url("//example.com/path"),
            "https://example.com/path"
        );
    }

    #[test]
    fn trim_snippet_keeps_cyrillic() {
        let s = "Привет мир, это тестовый сниппет с кириллицей";
        let out = trim_snippet(s);
        assert!(out.chars().count() <= SNIPPET_MAX_CHARS + 1); // +1 для "…"
    }

    #[test]
    fn trim_snippet_truncates_long() {
        let s: String = "a".repeat(SNIPPET_MAX_CHARS + 50);
        let out = trim_snippet(&s);
        assert!(out.ends_with('…'));
        assert!(out.chars().count() <= SNIPPET_MAX_CHARS + 1);
    }

    #[test]
    fn classify_habr() {
        assert_eq!(
            classify_source("https://habr.com/ru/articles/123/"),
            ("general", "Habr")
        );
    }

    #[test]
    fn classify_wikipedia() {
        assert_eq!(
            classify_source("https://en.wikipedia.org/wiki/Rust_(programming_language)"),
            ("wikipedia", "Wikipedia")
        );
    }

    #[test]
    fn classify_github() {
        assert_eq!(
            classify_source("https://github.com/rust-lang/rust"),
            ("general", "GitHub")
        );
    }

    #[test]
    fn url_dedup_key_normalizes_case_and_tracking() {
        // Case-insensitive host, utm_ отрезается, fragment отрезается.
        assert_eq!(
            url_dedup_key("https://EN.Wikipedia.org/wiki/Rust?foo=bar&utm_source=x#section"),
            "https://en.wikipedia.org/wiki/rust?foo=bar"
        );
        assert_eq!(
            url_dedup_key("https://example.com/path"),
            "https://example.com/path"
        );
    }

    #[test]
    fn dedup_by_url_keeps_first_occurrence() {
        let items = vec![
            SearchItem {
                title: "A".into(),
                url: "https://en.wikipedia.org/wiki/Rust".into(),
                snippet: "first".into(),
                source: "wikipedia".into(),
                site_name: "Wikipedia".into(),
            },
            SearchItem {
                title: "B".into(),
                url: "https://en.Wikipedia.org/wiki/Rust".into(),
                snippet: "second".into(),
                source: "wikipedia".into(),
                site_name: "Wikipedia".into(),
            },
            SearchItem {
                title: "C".into(),
                url: "https://github.com/rust-lang/rust".into(),
                snippet: "third".into(),
                source: "general".into(),
                site_name: "GitHub".into(),
            },
        ];
        let out = dedup_by_url(items);
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].snippet, "first");
        assert_eq!(out[1].url, "https://github.com/rust-lang/rust");
    }

    #[test]
    fn query_has_latin_detects_ascii_only() {
        assert!(query_has_latin("hello"));
        assert!(query_has_latin("SVE инструкции"));
        assert!(!query_has_latin("Привет мир"));
        assert!(!query_has_latin("12345"));
    }

    #[test]
    fn cache_key_normalizes_query_and_limit() {
        assert_eq!(cache_key("  Rust 1.83  ", 8), "rust 1.83:8");
        assert_eq!(cache_key("Rust 1.83", 5), "rust 1.83:5");
        assert_ne!(cache_key("Rust 1.83", 8), cache_key("Rust 1.83", 5));
    }

    #[test]
    fn cache_put_then_get_roundtrip() {
        // Очищаем кэш для теста (на случай, если другие тесты что-то положили)
        {
            let mut g = cache_ensure();
            *g = Some(std::collections::HashMap::new());
        }
        let key = cache_key("test-roundtrip-query", 5);
        let r = WebSearchResult {
            query: "test-roundtrip-query".into(),
            backend: "ddg-html".into(),
            total: 1,
            items: vec![SearchItem {
                title: "t".into(),
                url: "https://example.com/".into(),
                snippet: "s".into(),
                source: "general".into(),
                site_name: "Web".into(),
            }],
            offline: false,
            error: None,
        };
        cache_put(key.clone(), r.clone());
        let got = cache_get(&key).expect("cache miss after put");
        assert_eq!(got.backend, "ddg-html");
        assert_eq!(got.items.len(), 1);
        assert_eq!(got.items[0].url, "https://example.com/");
    }

    #[test]
    fn cache_does_not_store_empty_results() {
        {
            let mut g = cache_ensure();
            *g = Some(std::collections::HashMap::new());
        }
        let key = cache_key("offline-test", 5);
        let r = WebSearchResult {
            query: "offline-test".into(),
            backend: "none".into(),
            total: 0,
            items: vec![],
            offline: true,
            error: Some("no upstream".into()),
        };
        cache_put(key.clone(), r);
        assert!(cache_get(&key).is_none(), "offline results must not be cached");
    }
}
