// Pulse — voice-first AI side panel (Tauri v2 backend)
//
// Фичи (MVP):
//  - Оверлей-окно, прижатое к правому краю экрана (transparent + decorations: false)
//  - Позиция сохраняется в app config и восстанавливается при старте (с debounce)
//  - Трей-меню (Показать / Скрыть / Настройки / Выход) + click-to-toggle
//  - Закрытие по крестику = hide в трей (приложение продолжает работать)
//  - Глобальный хоткей Ctrl+Shift+Space — toggle окна
//  - search_habr(query) — проксирует на http://127.0.0.1:3000/api/search
//  - capture_screen() — нативный скриншот основного монитора (PNG → base64 + path)
//  - get_autostart() / set_autostart(enabled) — управление автозапуском ОС
//  - Файловый движок (v4 MVP): list_directory / file_info / read_text_file /
//    search_files / open_in_explorer + tauri-plugin-dialog (системный open-dialog)
//
// Pulse v5 — web search (модуль `web_search`):
//  - web_search(query) — DDG HTML → DDG Lite → Wikipedia (graceful fallback).
//    Frontend решает когда дёргать (эвристика `shouldWebSearch` в tools.ts).
//
// Pulse v5 — agentic AI (модуль `agent`):
//  - list_installed_apps / find_app / launch_app — поиск и запуск .exe, .lnk,
//    shell-URI (steam://, epic://, gog://) с кэшем в app_config_dir/apps.json
//  - list_games — парсер Steam .acf + libraryfolders.vdf, заглушки Epic/GOG/Battle.net
//  - list_running_processes — sysinfo, top-50 по памяти
//  - system_info — CPU/RAM/disk/uptime/battery
//  - open_url — дефолтный браузер через ShellExecute
//
// Что НЕ реализовано (только интерфейсы-заглушки во фронте):
//  - Wake word detection (web/src/voice/wakeword.ts)
//  - Speech-to-Text     (web/src/voice/stt.ts)
//  - OCR поверх capture_screen (web/src/screen/ocr.ts)
//  - LLM-ответы — реализован на фронте (web/src/llm/), не на бэке
//  - Индексация (Tantivy/sqlite-fts) — это v6

mod agent;
mod web_search;
mod youtube;

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewWindow,
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_shell::ShellExt;

#[derive(Default)]
struct AppState {
    visible: Mutex<bool>,
    /// Последний известный x/y и момент записи — для debounce в `save_window_state`.
    /// Option<(x, y, last_write_at)>
    last_window_pos: Mutex<Option<(i32, i32, Instant)>>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HabrItem {
    pub title: String,
    pub url: String,
    pub author: String,
    pub time: String,
    pub snippet: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct HabrSearchResult {
    pub query: String,
    pub total: u32,
    pub items: Vec<HabrItem>,
    pub offline: bool,
    pub error: Option<String>,
}

/// Поиск по Habr через локальный habr-search (Next.js, :3000).
/// Проксирует `GET {HABR_SEARCH_URL}/api/search?q=...&limit=...`.
/// `HABR_SEARCH_URL` берётся из env (по умолчанию `http://127.0.0.1:3000`).
/// Если сервис недоступен — возвращает offline=true (UI не виснет).
#[tauri::command]
async fn search_habr(query: String, limit: Option<u32>) -> Result<HabrSearchResult, String> {
    let limit = limit.unwrap_or(15).min(50);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())?;

    let base = std::env::var("HABR_SEARCH_URL")
        .unwrap_or_else(|_| "http://127.0.0.1:3000".to_string());
    let url = format!(
        "{}/api/search?q={}&limit={}",
        base.trim_end_matches('/'),
        urlencoding::encode(&query),
        limit
    );
    match client.get(&url).send().await {
        Ok(resp) if resp.status().is_success() => {
            let body: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
            let items: Vec<HabrItem> = body
                .get("items")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| {
                            // Тянем только title/url/author/time/snippet; hubs пропускаем.
                            serde_json::json!({
                                "title": v.get("title").cloned().unwrap_or(serde_json::Value::String(String::new())),
                                "url": v.get("url").cloned().unwrap_or(serde_json::Value::String(String::new())),
                                "author": v.get("author").cloned().unwrap_or(serde_json::Value::String(String::new())),
                                "time": v.get("time").cloned().unwrap_or(serde_json::Value::String(String::new())),
                                "snippet": v.get("snippet").cloned().unwrap_or(serde_json::Value::String(String::new())),
                            })
                            .pipe(|jv| serde_json::from_value::<HabrItem>(jv).ok())
                        })
                        .collect()
                })
                .unwrap_or_default();
            Ok(HabrSearchResult {
                query: body
                    .get("query")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&query)
                    .to_string(),
                total: body.get("total").and_then(|v| v.as_u64()).unwrap_or(0) as u32,
                items,
                offline: false,
                error: None,
            })
        }
        Ok(resp) => {
            let status = resp.status();
            let _ = resp.text().await;
            Ok(HabrSearchResult {
                query,
                total: 0,
                items: vec![],
                offline: true,
                error: Some(format!("habr-search returned {status}")),
            })
        }
        Err(e) => Ok(HabrSearchResult {
            query,
            total: 0,
            items: vec![],
            offline: true,
            error: Some(format!("habr-search offline: {e}. Запусти: cd ../habr-search && npm run dev. Или задай HABR_SEARCH_URL=http://host:port")),
        }),
    }
}

/// Нативный скриншот основного монитора через `xcap` (кросс-платформенно).
/// Возвращает base64 PNG (для превью в чате) + путь к файлу на диске.
#[tauri::command]
async fn capture_screen() -> Result<serde_json::Value, String> {
    use base64::Engine;

    let png_bytes = tokio::task::spawn_blocking(|| -> Result<Vec<u8>, String> {
        let monitors = xcap::Monitor::all().map_err(|e| format!("monitor: {e}"))?;
        let mon = monitors
            .into_iter()
            .next()
            .ok_or_else(|| "no monitor".to_string())?;
        let img = mon.capture_image().map_err(|e| format!("capture: {e}"))?;
        let dyn_img = image::DynamicImage::ImageRgba8(img);
        let mut buf = std::io::Cursor::new(Vec::<u8>::new());
        dyn_img
            .write_to(&mut buf, image::ImageFormat::Png)
            .map_err(|e| format!("png: {e}"))?;
        Ok(buf.into_inner())
    })
    .await
    .map_err(|e| format!("join: {e}"))??;

    let path = std::env::temp_dir().join(format!("pulse-shot-{}-{}.png", std::process::id(), chrono_unix()));
    let _ = std::fs::write(&path, &png_bytes);

    let b64 = base64::engine::general_purpose::STANDARD.encode(&png_bytes);
    Ok(serde_json::json!({
        "path": path.to_string_lossy(),
        "base64": b64,
        "bytes": png_bytes.len(),
    }))
}

fn chrono_unix() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

/// Маленький helper: serde_json::Value → Result<T> через «пайп».
trait Pipe: Sized {
    fn pipe<U, F: FnOnce(Self) -> U>(self, f: F) -> U {
        f(self)
    }
}
impl<T> Pipe for T {}

fn show_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.show().map_err(|e| e.to_string())?;
        win.set_focus().map_err(|e| e.to_string())?;
        let _ = win.set_always_on_top(true);
    }
    *app.state::<AppState>().visible.lock().unwrap() = true;
    Ok(())
}

fn hide_window(app: &AppHandle) -> Result<(), String> {
    if let Some(win) = app.get_webview_window("main") {
        win.hide().map_err(|e| e.to_string())?;
    }
    *app.state::<AppState>().visible.lock().unwrap() = false;
    // Принудительно сбрасываем последнюю позицию (debounce мог не сработать).
    force_save_window_state(app);
    Ok(())
}

fn toggle_window(app: &AppHandle) -> Result<bool, String> {
    let visible = *app.state::<AppState>().visible.lock().unwrap();
    if visible {
        hide_window(app)?;
        Ok(false)
    } else {
        show_window(app)?;
        Ok(true)
    }
}

#[tauri::command]
fn cmd_show(app: AppHandle) -> Result<(), String> {
    show_window(&app)
}
#[tauri::command]
fn cmd_hide(app: AppHandle) -> Result<(), String> {
    hide_window(&app)
}
#[tauri::command]
fn cmd_toggle(app: AppHandle) -> Result<bool, String> {
    toggle_window(&app)
}

/// Включён ли сейчас автозапуск (в ОС).
#[tauri::command]
fn get_autostart(app: AppHandle) -> Result<bool, String> {
    app.autolaunch().is_enabled().map_err(|e| e.to_string())
}

/// Включить/выключить автозапуск. При включении передаём флаг --minimized,
/// чтобы Pulse стартовал сразу свёрнутым в трей.
#[tauri::command]
fn set_autostart(app: AppHandle, enabled: bool) -> Result<bool, String> {
    let manager = app.autolaunch();
    if enabled {
        manager.enable().map_err(|e| e.to_string())?;
    } else {
        manager.disable().map_err(|e| e.to_string())?;
    }
    manager.is_enabled().map_err(|e| e.to_string())
}

// ─────────────────────────────────────────────────────────────────────────────
// Файловый движок (v4 MVP)
//
// Команды вызываются фронтом через `invoke('...')` и не требуют capabilities
// (тауri commands не gated). Tauri-plugin-dialog используется только из JS
// для системного диалога выбора файла; ему нужен permission `dialog:default`.
// ─────────────────────────────────────────────────────────────────────────────

/// Один элемент в результатах list_directory / file_info / search_files.
/// `modified` — unix-ms, None если FS не вернула (например FAT на флешке).
/// `is_dir`/`is_file` — удобно для UI (иконка/превью).
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileInfo {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
    pub is_file: bool,
    pub size: u64,
    pub modified: Option<i64>,
}

/// Конвертируем SystemTime → unix-ms. Если раньше UNIX_EPOCH (теоретически
/// на FAT для pre-1970) — возвращаем 0. Если ошибка — None.
fn system_time_to_ms(t: std::io::Result<std::time::SystemTime>) -> Option<i64> {
    t.ok()
        .and_then(|st| st.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as i64)
}

/// Построить FileInfo по `DirEntry`. Ошибки per-entry (битые симлинки и т.п.)
/// не валят весь list — просто пропускаем.
fn dir_entry_to_info(entry: std::fs::DirEntry) -> Option<FileInfo> {
    let meta = entry.metadata().ok()?;
    let name = entry.file_name().to_string_lossy().to_string();
    let path = entry.path().to_string_lossy().to_string();
    Some(FileInfo {
        name,
        path,
        is_dir: meta.is_dir(),
        is_file: meta.is_file(),
        size: meta.len(),
        modified: system_time_to_ms(meta.modified()),
    })
}

/// Содержимое директории: сначала папки (alpha), потом файлы (alpha).
/// Жёсткий лимит 1000 entries — защита от случайного открытия диска C:\.
/// Если лимит превышен — фронт получит `truncated: true`.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ListDirResult {
    pub entries: Vec<FileInfo>,
    pub truncated: bool,
    pub total: u32,
}

#[tauri::command]
async fn list_directory(path: String) -> Result<ListDirResult, String> {
    const MAX: usize = 1000;
    tokio::task::spawn_blocking(move || -> Result<ListDirResult, String> {
        let read = std::fs::read_dir(&path).map_err(|e| format!("read_dir({path}): {e}"))?;
        let mut iter = read.flatten();
        let mut dirs: Vec<FileInfo> = Vec::new();
        let mut files: Vec<FileInfo> = Vec::new();
        let mut total: u32 = 0;
        loop {
            let Some(entry) = iter.next() else { break };
            total += 1;
            if let Some(info) = dir_entry_to_info(entry) {
                if info.is_dir {
                    dirs.push(info);
                } else {
                    files.push(info);
                }
            }
            if dirs.len() + files.len() >= MAX {
                // Дочитываем оставшиеся только ради total, сами entries не сохраняем.
                while let Some(entry) = iter.next() {
                    if entry.metadata().is_ok() {
                        total += 1;
                    }
                }
                break;
            }
        }
        dirs.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
        let entries_total = dirs.len() + files.len();
        let truncated = entries_total >= MAX || total as usize > entries_total;
        let mut entries = dirs;
        entries.append(&mut files);
        Ok(ListDirResult {
            entries,
            truncated,
            total,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Метаданные одного пути. Может быть и файл, и папка.
#[tauri::command]
async fn file_info(path: String) -> Result<FileInfo, String> {
    tokio::task::spawn_blocking(move || -> Result<FileInfo, String> {
        let meta = std::fs::metadata(&path).map_err(|e| format!("metadata({path}): {e}"))?;
        let name = std::path::Path::new(&path)
            .file_name()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| path.clone());
        Ok(FileInfo {
            name,
            path: path.clone(),
            is_dir: meta.is_dir(),
            is_file: meta.is_file(),
            size: meta.len(),
            modified: system_time_to_ms(meta.modified()),
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Прочитать текстовый файл. Жёсткий лимит 5 МБ — больше в чат всё равно
/// не влезет. Бинарь вернёт `InvalidData`-ошибку.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct TextFileContent {
    pub path: String,
    pub content: String,
    pub size: u64,
    /// `true` если контент обрезан до 5 МБ; фронт решает, как показать.
    pub truncated: bool,
}

#[tauri::command]
async fn read_text_file(path: String) -> Result<TextFileContent, String> {
    const MAX_BYTES: u64 = 5 * 1024 * 1024;
    tokio::task::spawn_blocking(move || -> Result<TextFileContent, String> {
        let meta = std::fs::metadata(&path).map_err(|e| format!("metadata({path}): {e}"))?;
        if meta.len() > MAX_BYTES {
            return Err(format!(
                "Файл слишком большой: {} МБ (лимит {} МБ)",
                meta.len() / (1024 * 1024),
                MAX_BYTES / (1024 * 1024)
            ));
        }
        let bytes = std::fs::read(&path).map_err(|e| format!("read({path}): {e}"))?;
        // Грубая эвристика: если в первых 8 КБ есть NUL — это бинарь.
        let sniff_len = bytes.len().min(8192);
        if bytes[..sniff_len].contains(&0) {
            return Err(format!("Файл похож на бинарный (NUL-байты в первых {sniff_len} Б)"));
        }
        let content = String::from_utf8(bytes.clone())
            .map_err(|e| format!("Не UTF-8: {e}"))?;
        Ok(TextFileContent {
            path: path.clone(),
            content,
            size: meta.len(),
            truncated: false,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Рекурсивный поиск по имени (case-insensitive substring match).
/// `max_results` — жёсткий cap (default 50, max 500), `max_depth` = 12.
/// Пропускаем junction-points / симлинки (canonicalize на Windows) и
/// типичные «шумные» папки.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    pub query: String,
    pub root: String,
    pub hits: Vec<FileInfo>,
    pub truncated: bool,
}

#[tauri::command]
async fn search_files(
    root: String,
    query: String,
    max_results: Option<u32>,
) -> Result<SearchResult, String> {
    let max_results = max_results.unwrap_or(50).min(500) as usize;
    let q_lower = query.to_lowercase();
    tokio::task::spawn_blocking(move || -> Result<SearchResult, String> {
        let mut hits: Vec<FileInfo> = Vec::new();
        let mut truncated = false;
        walk(
            &root,
            &q_lower,
            0,
            12,
            max_results,
            &mut hits,
            &mut truncated,
        );
        Ok(SearchResult {
            query,
            root,
            hits,
            truncated,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Итератор по директориям: BFS с защитой от циклов (seen по canonical path).
/// `SKIP_DIRS` — типичные «шумные» папки, чтобы не уходить в node_modules/.git.
fn walk(
    dir: &str,
    q_lower: &str,
    depth: u32,
    max_depth: u32,
    max_results: usize,
    hits: &mut Vec<FileInfo>,
    truncated: &mut bool,
) {
    static SKIP: &[&str] = &[
        "node_modules",
        ".git",
        "target",
        "$RECYCLE.BIN",
        "System Volume Information",
        ".gradle",
        ".idea",
        ".vscode",
    ];
    if depth > max_depth || hits.len() >= max_results {
        return;
    }
    let read = match std::fs::read_dir(dir) {
        Ok(r) => r,
        Err(_) => return, // permission denied и т.п. — тихо
    };
    for entry in read.flatten() {
        if hits.len() >= max_results {
            *truncated = true;
            return;
        }
        let Some(info) = dir_entry_to_info(entry) else { continue };
        // skip junk by name
        if info.is_dir && SKIP.iter().any(|s| s.eq_ignore_ascii_case(&info.name)) {
            continue;
        }
        if info.name.to_lowercase().contains(q_lower) {
            hits.push(info.clone());
        }
        if info.is_dir {
            // защита от рекурсии в самого себя (уже был в read)
            walk(&info.path, q_lower, depth + 1, max_depth, max_results, hits, truncated);
        }
    }
}

/// Открыть путь в системном проводнике. Для файла — подсветим его
/// (explorer.exe /select,"path"); для папки — откроем саму папку.
#[tauri::command]
async fn open_in_explorer(path: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let p = std::path::Path::new(&path);
        if !p.exists() {
            return Err(format!("Путь не существует: {path}"));
        }
        #[cfg(target_os = "windows")]
        {
            if p.is_file() {
                // /select подсвечивает файл в его родительской папке.
                std::process::Command::new("explorer.exe")
                    .arg(format!("/select,{}", p.to_string_lossy()))
                    .spawn()
                    .map_err(|e| format!("explorer: {e}"))?;
            } else {
                std::process::Command::new("explorer.exe")
                    .arg(p)
                    .spawn()
                    .map_err(|e| format!("explorer: {e}"))?;
            }
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open")
                .arg(p)
                .spawn()
                .map_err(|e| format!("open: {e}"))?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open")
                .arg(p)
                .spawn()
                .map_err(|e| format!("xdg-open: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

/// Сохранить позицию окна в app config (JSON), с debounce 200мс.
/// На каждое `Moved`-событие обновляет «последнюю» позицию в state, но реально
/// пишет файл не чаще раза в 200мс. Финальный flush делается в `force_save_window_state`.
fn save_window_state(app: &AppHandle, x: i32, y: i32) {
    let state = app.state::<AppState>();
    let mut guard = match state.last_window_pos.lock() {
        Ok(g) => g,
        Err(_) => return,
    };

    let now = Instant::now();
    let should_flush = match *guard {
        None => true,
        Some((_, _, last)) => now.duration_since(last) >= Duration::from_millis(200),
    };
    *guard = Some((x, y, now));
    drop(guard);

    if should_flush {
        write_window_state(app, x, y);
    }
}

/// Принудительно записать последнюю сохранённую позицию (вызывать при hide/quit).
fn force_save_window_state(app: &AppHandle) {
    let state = app.state::<AppState>();
    let (x, y) = match state.last_window_pos.lock() {
        Ok(g) => match *g {
            Some((x, y, _)) => (x, y),
            None => return,
        },
        Err(_) => return,
    };
    write_window_state(app, x, y);
}

fn write_window_state(app: &AppHandle, x: i32, y: i32) {
    let Some(dir) = app.path().app_config_dir().ok() else { return };
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("window-state.json");
    let payload = serde_json::json!({ "x": x, "y": y });
    if let Ok(s) = serde_json::to_string(&payload) {
        let _ = std::fs::write(path, s);
    }
}

fn load_window_state(app: &AppHandle) -> Option<(i32, i32)> {
    let dir = app.path().app_config_dir().ok()?;
    let s = std::fs::read_to_string(dir.join("window-state.json")).ok()?;
    let v: serde_json::Value = serde_json::from_str(&s).ok()?;
    let x = v.get("x")?.as_i64()? as i32;
    let y = v.get("y")?.as_i64()? as i32;
    Some((x, y))
}

/// Прижать окно к правому краю основного монитора на всю высоту.
///
/// `preferred_y` — если есть (из сохранённого состояния), используем его,
/// иначе прижимаем к верху (y=0). В любом случае высота = высота монитора.
fn snap_to_right_edge(win: &WebviewWindow, preferred_y: Option<i32>) -> Result<(), String> {
    let monitor = win
        .primary_monitor()
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "no primary monitor".to_string())?;
    let m_size = monitor.size();
    let scale = monitor.scale_factor();

    // Ширина фиксированная ~380, высота = высота экрана.
    let new_w = 380_u32;
    let new_h = m_size.height; // full height монитора

    // X — прижать к правому краю (с учётом DPI-скейла)
    let x = (m_size.width as i32).saturating_sub((new_w as f64 * scale) as i32).max(0);

    // Y: если есть сохранённый — клампим в пределы экрана, иначе 0 (верх).
    // Держим минимум 100px видимой области сверху, чтобы юзер не потерял окно.
    let min_visible = 100_i32;
    let max_y = (m_size.height as i32).saturating_sub(min_visible);
    let y = preferred_y
        .unwrap_or(0)
        .clamp(0, max_y.max(0));

    win.set_size(PhysicalSize::new(
        (new_w as f64 * scale) as u32,
        (new_h as f64 * scale) as u32,
    ))
    .map_err(|e| e.to_string())?;
    win.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn build_tray(app: &AppHandle) -> tauri::Result<()> {
    let show = MenuItem::with_id(app, "show", "Показать Pulse", true, None::<&str>)?;
    let hide = MenuItem::with_id(app, "hide", "Скрыть в трей", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Настройки", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &hide, &settings, &quit])?;

    TrayIconBuilder::with_id("pulse-tray")
        .menu(&menu)
        .tooltip("Pulse — voice-first AI side panel")
        .icon(app.default_window_icon().cloned().unwrap_or_else(|| {
            tauri::image::Image::from_bytes(include_bytes!("../icons/icon.png"))
                .expect("icon.png")
        }))
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                let _ = show_window(app);
            }
            "hide" => {
                let _ = hide_window(app);
            }
            "settings" => {
                // Открываем панель и эмитим событие — фронт переключится на вкладку настроек
                let _ = show_window(app);
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.emit("tray-open-settings", ());
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                let _ = toggle_window(app);
            }
        })
        .build(app)?;
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// Ollama sidecar
//
// Раньше Pulse требовал ручного `ollama serve` (иначе после ребута компа
// не работал). Теперь при старте приложения поднимаем `ollama serve` сами,
// через Tauri sidecar pattern (бинарь лежит в src-tauri/binaries/, в dev
// Tauri его находит, в release копирует в Resources).
//
// Через 3 сек после спавна делаем health-check GET /api/tags на :11434.
// Результат эмитим в UI как `ollama-ready` (успех) или `ollama-failed`
// (бинарь не запустился / не отвечает) — фронт показывает баннер.
// ─────────────────────────────────────────────────────────────────────────────

fn spawn_ollama_sidecar(app: &AppHandle) {
    // setup() — синхронный, поэтому уходим в async runtime сразу.
    // 1) Probe :11434 — если ollama уже отвечает (юзер поднял руками или
    //    осталась с прошлого запуска), не спавним вторую, сразу эмитим ready.
    // 2) Иначе спавним sidecar и через 3 сек проверяем готовность.
    let app_handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let probe_client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_millis(500))
            .build()
        {
            Ok(c) => c,
            Err(_) => reqwest::Client::new(), // fallthrough — попробуем спавнить
        };
        if let Ok(resp) = probe_client.get("http://127.0.0.1:11434/api/tags").send().await {
            if resp.status().is_success() {
                println!("[pulse] ollama already up on :11434, skipping sidecar spawn");
                let _ = app_handle.emit("ollama-ready", ());
                return;
            }
        }

        let shell = app_handle.shell();
        let spawn_result = shell.command("ollama").args(["serve"]).spawn();

        if let Err(e) = &spawn_result {
            eprintln!("[pulse] failed to spawn ollama sidecar: {e}");
            let _ = app_handle.emit("ollama-failed", format!("spawn failed: {e}"));
            return;
        }
        println!("[pulse] ollama sidecar spawned, waiting for :11434...");

        // Ollama обычно поднимается за 1-2 сек, но пусть будет запас.
        tokio::time::sleep(std::time::Duration::from_secs(3)).await;

        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        {
            Ok(c) => c,
            Err(e) => {
                let _ = app_handle.emit("ollama-failed", format!("reqwest build: {e}"));
                return;
            }
        };

        match client.get("http://127.0.0.1:11434/api/tags").send().await {
            Ok(resp) if resp.status().is_success() => {
                println!("[pulse] ollama up on :11434");
                let _ = app_handle.emit("ollama-ready", ());
            }
            Ok(resp) => {
                let err = format!("ollama :11434 returned {}", resp.status());
                eprintln!("[pulse] {err}");
                let _ = app_handle.emit("ollama-failed", err);
            }
            Err(e) => {
                let err = format!(
                    "ollama не отвечает на :11434: {e}. Запусти вручную: ollama serve"
                );
                eprintln!("[pulse] {err}");
                let _ = app_handle.emit("ollama-failed", err);
            }
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            search_habr,
            capture_screen,
            cmd_show,
            cmd_hide,
            cmd_toggle,
            get_autostart,
            set_autostart,
            list_directory,
            file_info,
            read_text_file,
            search_files,
            open_in_explorer,
            // Pulse v5 — web search (auto-invoked by frontend heuristic)
            web_search::web_search,
            // Pulse v5 — agentic AI
            agent::list_installed_apps,
            agent::find_app,
            agent::launch_app,
            agent::list_games,
            agent::list_running_processes,
            agent::system_info,
            agent::open_url,
            youtube::youtube_latest,
        ])
        .setup(|app| {
            // Поднимаем Ollama в фоне (sidecar) ДО остальной инициализации,
            // чтобы к моменту UI-чека она уже стартовала.
            spawn_ollama_sidecar(&app.handle());

            // Build tray
            build_tray(&app.handle())?;

            // Global hotkey: Ctrl+Shift+Space — toggle window
            let handle = app.handle().clone();
            app.global_shortcut()
                .on_shortcut("CmdOrCtrl+Shift+Space", move |_app, _scut, event| {
                    if event.state() == ShortcutState::Pressed {
                        let _ = toggle_window(&handle);
                    }
                })?;

            // Позиция и размер окна при старте
            if let Some(win) = app.get_webview_window("main") {
                // Сохранённую y-координату используем как «предпочтение»,
                // но X и высоту всё равно пересчитываем от монитора — чтобы
                // панель всегда была прижата к правому краю и на всю высоту,
                // даже если у юзера 1080p, 1440p, 4K или разные DPI.
                let saved_y = load_window_state(&app.handle()).map(|(_, y)| y);
                let _ = snap_to_right_edge(&win, saved_y);
                // Auto-minimize в трей, если передан флаг --minimized (autostart)
                let args: Vec<String> = std::env::args().collect();
                if args.iter().any(|a| a == "--minimized") {
                    let _ = hide_window(&app.handle());
                }
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            match event {
                // Крестик = спрятать в трей, не выходить
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    if window.label() == "main" {
                        api.prevent_close();
                        let _ = hide_window(&window.app_handle().clone());
                    }
                }
                // Сохраняем новую позицию после перетаскивания (с debounce)
                tauri::WindowEvent::Moved(pos) => {
                    save_window_state(&window.app_handle().clone(), pos.x, pos.y);
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
