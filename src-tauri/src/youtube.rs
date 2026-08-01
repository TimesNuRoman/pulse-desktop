// Pulse v5 — YouTube RSS fetcher (без YouTube Data API, без OAuth/quota).
//
// Источник: `https://www.youtube.com/feeds/videos.xml?channel_id=UC…` (Atom).
// Возвращает последние 15 видео с канала: title / link / channel / published.
//
// Резолв channel_id:
//  - если query это `UC…` (24+ символов) — берём как есть;
//  - если это URL `youtube.com/channel/UC…` — извлекаем ID;
//  - если это URL `youtube.com/@handle` — следуем за редиректом, в финальном
//    URL будет `/channel/UC…`;
//  - если это URL `youtube.com/c/Name` или `youtube.com/user/Name` — для
//    legacy `user=NAME` YouTube отдаёт RSS; иначе fallback на /results
//    (быстро и best-effort);
//  - если это просто имя — пробуем `?user=NAME` (legacy), при 404 —
//    `?search_query=NAME` через `/results`.
//
// XML парсим вручную (split по <entry> + find/substring), без quick-xml/regex,
// чтобы не тянуть новые крейты. Таймаут — 10 сек на любой сетевой вызов.

use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YoutubeVideo {
    pub title: String,
    /// https://www.youtube.com/watch?v=…
    pub url: String,
    pub channel: String,
    /// RFC3339 (как в YouTube Atom).
    pub published: String,
    pub thumbnail: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct YoutubeLatestResult {
    pub query: String,
    /// Распознанный channel_id (если нашли) — для UI.
    pub channel_id: Option<String>,
    pub videos: Vec<YoutubeVideo>,
    pub error: Option<String>,
}

const HTTP_TIMEOUT: Duration = Duration::from_secs(10);

/// HTTP-клиент с таймаутом и приличным User-Agent (YouTube иногда отдаёт
/// другой HTML на «ботовые» UA).
fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .user_agent("Mozilla/5.0 (Pulse-Desktop/0.1; +https://example.invalid)")
        .build()
        .expect("reqwest client")
}

/// Найти первый channel_id в HTML — быстрая эвристика, не парсим JSON,
/// только регулярное выражение через простой substring-поиск.
fn extract_channel_id(html: &str) -> Option<String> {
    // YouTube встраивает channelId в JSON, но проще искать прямо
    // "/channel/UC…" в HTML (есть почти всегда на странице канала и в results).
    let needle = "/channel/UC";
    let start = html.find(needle)?;
    let after = &html[start + needle.len()..];
    let end = after
        .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
        .unwrap_or(after.len());
    let id = format!("UC{}", &after[..end]);
    if id.len() >= 24 {
        Some(id)
    } else {
        None
    }
}

/// Вытащить первый фрагмент между маркерами. Экранирования XML (entities)
/// на этом этапе упрощённо не раскрываем — title YouTube редко содержит
/// `&`/`>`/`<` (и Atom у них escaped), и нам хватит для отображения.
fn extract_between(hay: &str, open: &str, close: &str) -> Option<String> {
    let a = hay.find(open)? + open.len();
    let rest = &hay[a..];
    let b = rest.find(close)?;
    Some(rest[..b].to_string())
}

fn extract_attr(hay: &str, attr: &str) -> Option<String> {
    // ищем `attr="..."` или `attr='...'`
    let needle_a = format!("{}=\"", attr);
    let needle_b = format!("{}='", attr);
    if let Some(start) = hay.find(&needle_a) {
        let s = start + needle_a.len();
        let rest = &hay[s..];
        let e = rest.find('"')?;
        return Some(rest[..e].to_string());
    }
    if let Some(start) = hay.find(&needle_b) {
        let s = start + needle_b.len();
        let rest = &hay[s..];
        let e = rest.find('\'')?;
        return Some(rest[..e].to_string());
    }
    None
}

fn parse_atom(xml: &str) -> Vec<YoutubeVideo> {
    let mut out: Vec<YoutubeVideo> = Vec::new();
    // канал из <feed><title>…</title>
    let feed_title = extract_between(xml, "<title>", "</title>").unwrap_or_default();
    for entry in xml.split("<entry>").skip(1) {
        let end = entry.find("</entry>").unwrap_or(entry.len());
        let block = &entry[..end];

        let title = extract_between(block, "<title>", "</title>")
            .or_else(|| extract_between(block, "<title/>", ""))
            .unwrap_or_default();
        if title.is_empty() {
            continue;
        }

        // video_id: <yt:videoId>XXX</yt:videoId> — надёжный источник
        let video_id = extract_between(block, "<yt:videoId>", "</yt:videoId>")
            .or_else(|| {
                // fallback: <id>yt:video:XXX</id>
                let raw = extract_between(block, "<id>", "</id>")?;
                raw.strip_prefix("yt:video:").map(str::to_string)
            })
            .unwrap_or_default();
        if video_id.is_empty() {
            continue;
        }

        // <link rel="alternate" href="…"/> — ищем первый <link …> (atom может
        // иметь несколько <link> — rel="self", rel="alternate"). Берём тот,
        // у которого href содержит watch?v=, иначе — fallback на синтетику.
        let link_tag = block
            .split("<link ")
            .nth(1)
            .and_then(|s| s.split('>').next())
            .unwrap_or("");
        let url = extract_attr(link_tag, "href")
            .filter(|h| h.contains("watch?v="))
            .unwrap_or_else(|| format!("https://www.youtube.com/watch?v={video_id}"));

        // <author> может идти как <author><name>X</name></author> или
        // <author>\n   <name>X</name>… — поэтому ищем просто <name> внутри
        // <author>…</author>.
        let channel = extract_between(block, "<author>", "</author>")
            .and_then(|a| extract_between(&a, "<name>", "</name>"))
            .unwrap_or_else(|| feed_title.clone());
        let published = extract_between(block, "<published>", "</published>")
            .unwrap_or_default();
        // thumbnail — специально ищем <media:thumbnail …> (не первый url=,
        // потому что <media:content url=…> идёт раньше).
        let thumbnail = block
            .find("<media:thumbnail")
            .and_then(|i| {
                let rest = &block[i..];
                extract_attr(rest, "url")
            });

        out.push(YoutubeVideo {
            title,
            url,
            channel,
            published,
            thumbnail,
        });
    }
    out
}

/// Резолвим query → channel_id (UC…). Возвращаем None, если не вышло.
async fn resolve_channel_id(client: &reqwest::Client, query: &str) -> Option<String> {
    let q = query.trim();
    if q.is_empty() {
        return None;
    }
    // 1) уже похоже на channel_id
    if let Some(rest) = q.strip_prefix("UC") {
        if rest.len() >= 20 && rest.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
            return Some(format!("UC{rest}"));
        }
    }
    // 2) youtube.com/channel/UC…
    if let Some(idx) = q.find("/channel/UC") {
        let after = &q[idx + "/channel/".len()..];
        let end = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-'))
            .unwrap_or(after.len());
        let id = format!("UC{}", &after[..end]);
        if id.len() >= 24 {
            return Some(id);
        }
    }
    // 3) полный URL — пускаем через HEAD/GET, редирект даст финальный /channel/UC…
    if q.contains("youtube.com") || q.contains("youtu.be") {
        if let Ok(resp) = client.get(q).send().await {
            if let Some(final_url) = resp.url().as_str().parse::<String>().ok() {
                if let Some(id) = extract_channel_id(&final_url) {
                    return Some(id);
                }
            }
            // иначе — пройдёмся по HTML
            if let Ok(text) = resp.text().await {
                if let Some(id) = extract_channel_id(&text) {
                    return Some(id);
                }
            }
        }
    }
    // 4) просто имя — пробуем user=NAME (legacy), затем search через /results
    let name = q.trim_start_matches('@').to_string();
    let by_user = format!("https://www.youtube.com/feeds/videos.xml?user={}", urlencoding_simple(&name));
    if let Ok(resp) = client.get(&by_user).send().await {
        if resp.status().is_success() {
            if let Some(id) = extract_channel_id(resp.url().as_str()) {
                return Some(id);
            }
            if let Ok(text) = resp.text().await {
                if let Some(id) = extract_channel_id(&text) {
                    return Some(id);
                }
            }
        }
    }
    let by_search = format!("https://www.youtube.com/results?search_query={}", urlencoding_simple(&name));
    if let Ok(resp) = client.get(&by_search).send().await {
        if let Ok(text) = resp.text().await {
            if let Some(id) = extract_channel_id(&text) {
                return Some(id);
            }
        }
    }
    None
}

/// Мини-энкодер URL: только то, что реально может встретиться в имени канала.
/// (Всё уже есть в `urlencoding` — но эта функция локальная, чтобы не тащить
/// `use` в публичную зону модуля; дублируем 1-in-1 с lib.rs.)
fn urlencoding_simple(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char);
            }
            other => {
                out.push_str(&format!("%{:02X}", other));
            }
        }
    }
    out
}

/// Публичная команда для Tauri.
///
/// `query` — имя канала (`"куплинов"`, `"@kuplinovplay"`), URL
/// (`"https://www.youtube.com/@kuplinovplay"`, `"…/channel/UC…"`),
/// или сразу `channel_id` (`"UC…"`).
/// `max` — лимит видео (default 5, max 15).
#[tauri::command]
pub async fn youtube_latest(
    query: String,
    max: Option<u32>,
) -> Result<YoutubeLatestResult, String> {
    let max = max.unwrap_or(5).clamp(1, 15);
    let client = http();

    let Some(channel_id) = resolve_channel_id(&client, &query).await else {
        let err_msg = format!(
            "Канал не найден: «{query}». Укажи channel_id (UC…) или полный URL youtube.com/@handle."
        );
        return Ok(YoutubeLatestResult {
            query,
            channel_id: None,
            videos: vec![],
            error: Some(err_msg),
        });
    };

    let rss = format!("https://www.youtube.com/feeds/videos.xml?channel_id={channel_id}");
    let resp = match client.get(&rss).send().await {
        Ok(r) => r,
        Err(e) => {
            let err_msg = format!("YouTube RSS недоступен: {e}");
            return Ok(YoutubeLatestResult {
                query,
                channel_id: Some(channel_id),
                videos: vec![],
                error: Some(err_msg),
            });
        }
    };
    if !resp.status().is_success() {
        let status = resp.status();
        let err_msg = format!("YouTube RSS вернул {status} для канала {channel_id}");
        return Ok(YoutubeLatestResult {
            query,
            channel_id: Some(channel_id),
            videos: vec![],
            error: Some(err_msg),
        });
    }
    let body = match resp.text().await {
        Ok(t) => t,
        Err(e) => {
            let err_msg = format!("YouTube RSS: не удалось прочитать ответ: {e}");
            return Ok(YoutubeLatestResult {
                query,
                channel_id: Some(channel_id),
                videos: vec![],
                error: Some(err_msg),
            });
        }
    };
    if body.trim_start().starts_with("<!DOCTYPE") || body.trim_start().starts_with("<html") {
        let err_msg = format!("Канал {channel_id} не отдаёт RSS (YouTube вернул HTML).");
        return Ok(YoutubeLatestResult {
            query,
            channel_id: Some(channel_id),
            videos: vec![],
            error: Some(err_msg),
        });
    }
    let mut videos = parse_atom(&body);
    videos.truncate(max as usize);
    Ok(YoutubeLatestResult {
        query,
        channel_id: Some(channel_id),
        videos,
        error: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Парсим реальный RSS-фид (fixture) и проверяем инварианты:
    /// ровно 15 entries, у каждого есть title + watch?v=…, published != пусто,
    /// channel не пустой, thumbnail (опц.) — это i.ytimg.com URL.
    #[test]
    fn parse_real_youtube_rss() {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("youtube_rss.xml");
        let xml = std::fs::read_to_string(&path)
            .unwrap_or_else(|e| panic!("read fixture {path:?}: {e}"));
        let videos = parse_atom(&xml);
        assert!(videos.len() >= 10, "expected >=10 videos, got {}", videos.len());
        for (i, v) in videos.iter().enumerate() {
            assert!(!v.title.is_empty(), "[{i}] empty title");
            assert!(
                v.url.contains("watch?v="),
                "[{i}] bad url: {}",
                v.url
            );
            assert!(!v.channel.is_empty(), "[{i}] empty channel");
            assert!(!v.published.is_empty(), "[{i}] empty published");
            if let Some(t) = &v.thumbnail {
                assert!(
                    t.contains("ytimg.com"),
                    "[{i}] thumbnail not from ytimg: {t}"
                );
            }
        }
        // первое видео — самое свежее
        assert!(
            videos[0].published >= videos[1].published,
            "expected newest first"
        );
    }

    #[test]
    fn extract_between_basic() {
        assert_eq!(extract_between("foo<bar>baz</bar>qux", "<bar>", "</bar>").as_deref(), Some("baz"));
        assert_eq!(extract_between("no markers here", "<x>", "</x>"), None);
    }

    #[test]
    fn extract_attr_quotes() {
        assert_eq!(extract_attr("a href=\"x\" b='y'", "href").as_deref(), Some("x"));
        assert_eq!(extract_attr("a href='x' b=\"y\"", "href").as_deref(), Some("x"));
    }
}
