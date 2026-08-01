// Pulse — web search (general-purpose).
//
// Frontend вызывает `invoke('web_search', { query, limit })` после эвристики
// `shouldWebSearch` (см. web/src/llm/tools.ts). Внутри — три fallback'а:
//
//   1) DuckDuckGo HTML   (https://html.duckduckgo.com/html/?q=...)
//   2) DuckDuckGo Lite   (https://lite.duckduckgo.com/lite/?q=...)
//   3) Wikipedia REST    (для "что такое X", "кто такой Y")
//
// На каждом шаге: парсим, если получили ≥1 item — возвращаем сразу. Иначе
// идём к следующему. Если все три провалились — graceful degradation:
// items=[], offline=true, error=Some(...).
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
    Ok(parse_ddg_html(&html))
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
    Ok(parse_ddg_lite(&html))
}

async fn try_wikipedia(query: &str, client: &reqwest::Client) -> Result<Vec<SearchItem>, String> {
    // Lang: ru если есть кириллица, иначе en.
    let lang = if query.chars().any(|c| ('\u{0400}'..='\u{04FF}').contains(&c)) {
        "ru"
    } else {
        "en"
    };
    // OpenSearch API: [query, [titles], [descs], [urls]]
    let url = format!(
        "https://{lang}.wikipedia.org/w/api.php?action=opensearch&format=json&limit=5&search={}",
        urlencoding::encode(query)
    );
    let resp = client
        .get(&url)
        .header("User-Agent", WEB_SEARCH_UA)
        .send()
        .await
        .map_err(|e| format!("wikipedia: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("wikipedia: HTTP {}", resp.status()));
    }
    let json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("wikipedia: json: {e}"))?;
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
    Ok(out)
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

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    // 1) DDG HTML — основной backend
    match try_ddg_html(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            return Ok(WebSearchResult {
                query,
                backend: "ddg-html".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            });
        }
        Ok(_) => {} // пусто — пробуем lite
        Err(e) => eprintln!("[pulse] web_search ddg-html failed: {e}"),
    }

    // 2) DDG Lite — полегче HTML, иногда работает когда HTML блочит
    match try_ddg_lite(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            return Ok(WebSearchResult {
                query,
                backend: "ddg-lite".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            });
        }
        Ok(_) => {}
        Err(e) => eprintln!("[pulse] web_search ddg-lite failed: {e}"),
    }

    // 3) Wikipedia — для factual ("что такое X", "кто такой Y")
    match try_wikipedia(&query, &client).await {
        Ok(mut items) if !items.is_empty() => {
            items.truncate(limit);
            return Ok(WebSearchResult {
                query,
                backend: "wikipedia".to_string(),
                total: items.len() as u32,
                items,
                offline: false,
                error: None,
            });
        }
        Ok(_) => {}
        Err(e) => eprintln!("[pulse] web_search wikipedia failed: {e}"),
    }

    // Все три провалились или вернули пусто
    Ok(WebSearchResult {
        query,
        backend: "none".to_string(),
        total: 0,
        items: vec![],
        offline: true,
        error: Some(
            "Все поисковики (DDG HTML, DDG Lite, Wikipedia) вернули пусто или недоступны. Проверь интернет."
                .to_string(),
        ),
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
}
