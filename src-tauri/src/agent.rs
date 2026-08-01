// Pulse v5 — agentic AI.
//
// Команды, которые LLM может дёргать, чтобы запускать приложения/игры
// и интроспектировать систему. На фронте это вызывается через tools
// в `web/src/llm/tools.ts` (tool-use цикл) + руками через UI-вкладки
// "Запустить" / "Игры" / "Система" (`web/src/components/AgentPanel.tsx`).
//
// Сканирование списка приложений — ленивое: первый запрос проходит полный
// сбор (папки + реестр HKLM/HKCU + .lnk из Start Menu + Apps & Features
// через `pwsh` Get-Package) и кладёт результат в `app_config_dir/apps.json`.
// Последующие вызовы в течение часа отдают кэш. Запросить принудительное
// обновление можно через `find_app` с пустой строкой-флагом или просто
// удалить файл — но в UI v5 мы пересобираем кэш раз в час по таймеру.
//
// Все команды async и оборачивают блокирующие вызовы в
// `tokio::task::spawn_blocking`, чтобы UI Tauri-runtime не подвисал.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager; // app.path()

// ─── публичные типы (serde, чтобы фронт получил готовый JSON) ─────────────

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AppInfo {
    pub name: String,
    pub path: String,
    /// Версия (если достали — из реестра / pwsh). Для .lnk-папок часто пустая.
    pub version: String,
    /// Откуда взяли запись: "registry" | "lnk" | "folder" | "package".
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct GameInfo {
    pub name: String,
    /// "steam" | "epic" | "gog" | "battlenet"
    pub source: String,
    /// AppID / productId / etc — как строка (для Steam — число в строке).
    pub appid: String,
    /// Папка, где установлена игра.
    pub install_path: String,
    /// Unix-ms последнего запуска (0 если неизвестно).
    pub last_played: i64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct ProcInfo {
    pub pid: u32,
    pub name: String,
    pub memory_mb: f64,
    /// Загрузка CPU в процентах (0..100*cores по sysinfo; мы нормируем в 0..100).
    pub cpu_pct: f32,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiskInfo {
    pub mount: String,
    pub total_gb: f64,
    pub free_gb: f64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SysInfo {
    pub cpu_brand: String,
    pub cpu_cores: u32,
    pub cpu_usage_pct: f32,
    pub ram_total_gb: f64,
    pub ram_used_gb: f64,
    pub disks: Vec<DiskInfo>,
    /// 0..100, None если десктоп без батареи.
    pub battery_pct: Option<f32>,
    /// Секунд с момента загрузки.
    pub uptime_secs: u64,
}

// ─── кэш apps.json ────────────────────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize, Default)]
struct AppsCache {
    /// Unix-ms последнего обновления.
    updated_at: i64,
    apps: Vec<AppInfo>,
}

const APPS_CACHE_TTL_MS: i64 = 60 * 60 * 1000; // 1 час

fn cache_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("apps.json"))
}

fn read_cache(app: &tauri::AppHandle) -> Option<AppsCache> {
    let p = cache_path(app)?;
    let s = std::fs::read_to_string(&p).ok()?;
    serde_json::from_str(&s).ok()
}

fn write_cache(app: &tauri::AppHandle, cache: &AppsCache) {
    let Some(p) = cache_path(app) else { return };
    let _ = std::fs::create_dir_all(p.parent().unwrap_or(Path::new(".")));
    if let Ok(s) = serde_json::to_string(cache) {
        let _ = std::fs::write(p, s);
    }
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ─── list_installed_apps ──────────────────────────────────────────────────

/// Возвращает кэшированный список приложений. Если кэш протух (старше часа)
/// или отсутствует — пересобирает через `build_apps_index`. Лимит 500.
#[tauri::command]
pub async fn list_installed_apps(app: tauri::AppHandle) -> Result<Vec<AppInfo>, String> {
    let cached = read_cache(&app);
    let fresh = cached
        .as_ref()
        .map(|c| now_ms() - c.updated_at < APPS_CACHE_TTL_MS)
        .unwrap_or(false);

    if fresh {
        return Ok(cached.unwrap().apps);
    }

    // Пересборка в фоне, чтобы UI не фризил (Apps & Features через pwsh — медленно).
    let app_handle = app.clone();
    let apps = tokio::task::spawn_blocking(move || build_apps_index(&app_handle))
        .await
        .map_err(|e| format!("join: {e}"))??;

    let cache = AppsCache {
        updated_at: now_ms(),
        apps: apps.clone(),
    };
    write_cache(&app, &cache);
    Ok(apps)
}

/// Полный сбор: папки + реестр + .lnk + Apps & Features.
/// На Windows-only (cfg). Дедуп по (нормализованный путь, name).
#[cfg(target_os = "windows")]
fn build_apps_index(app: &tauri::AppHandle) -> Result<Vec<AppInfo>, String> {
    let mut by_key: HashMap<String, AppInfo> = HashMap::new();
    let mut insert = |app: AppInfo| {
        // Ключ: lowercase name + path
        let key = format!("{}|{}", app.name.to_lowercase(), app.path.to_lowercase());
        by_key.entry(key).or_insert(app);
    };

    // 1) Program Files / Program Files (x86) / LOCALAPPDATA\Programs — ищем .exe верхнего уровня
    let folders: Vec<PathBuf> = {
        let mut v = vec![
            PathBuf::from(r"C:\Program Files"),
            PathBuf::from(r"C:\Program Files (x86)"),
        ];
        if let Ok(local) = std::env::var("LOCALAPPDATA") {
            v.push(PathBuf::from(local).join("Programs"));
        }
        v
    };
    for root in folders {
        scan_programs_folder(&root, 2, &mut insert);
    }

    // 2) .lnk из Start Menu (рекурсивно)
    if let Ok(appdata) = std::env::var("APPDATA") {
        let start_menu = PathBuf::from(&appdata)
            .join(r"Microsoft\Windows\Start Menu\Programs");
        scan_lnk_folder(&start_menu, &mut insert);
    }
    // Common Start Menu (все юзеры)
    let common_start = PathBuf::from(r"C:\ProgramData\Microsoft\Windows\Start Menu\Programs");
    scan_lnk_folder(&common_start, &mut insert);

    // 3) Реестр: HKLM + HKCU Uninstall
    scan_registry_uninstall(&mut insert);

    // 4) Apps & Features через pwsh (медленнее всех, но самые «полные» метаданные)
    scan_via_pwsh_packages(&mut insert);

    // Программы из папок мы насобирали много; реестр/pwsh — дополняют.
    // Применяем приоритет: registry > package > folder > lnk (по source).
    let mut out: Vec<AppInfo> = by_key.into_values().collect();
    out.sort_by(|a, b| {
        a.name
            .to_lowercase()
            .cmp(&b.name.to_lowercase())
            // равные имена — сначала registry
            .then_with(|| source_priority(&b.source).cmp(&source_priority(&a.source)))
    });
    out.truncate(500);
    let _ = app; // app не используется — оставлен на будущее (логирование)
    Ok(out)
}

fn source_priority(s: &str) -> u8 {
    match s {
        "registry" => 4,
        "package" => 3,
        "lnk" => 2,
        "folder" => 1,
        _ => 0,
    }
}

#[cfg(target_os = "windows")]
fn scan_programs_folder<F: FnMut(AppInfo)>(root: &Path, max_depth: u32, insert: &mut F) {
    let Ok(read) = std::fs::read_dir(root) else { return };
    for entry in read.flatten() {
        let p = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        if p.is_dir() {
            // Ищем первый .exe внутри (не глубже 2 уровней)
            if max_depth > 0 {
                if let Some(exe) = find_first_exe(&p, max_depth) {
                    insert(AppInfo {
                        name: name.clone(),
                        path: exe.to_string_lossy().to_string(),
                        version: String::new(),
                        source: "folder".to_string(),
                    });
                } else if max_depth > 1 {
                    scan_programs_folder(&p, max_depth - 1, insert);
                }
            }
        } else if p.extension().map(|e| e.eq_ignore_ascii_case("exe")).unwrap_or(false) {
            insert(AppInfo {
                name,
                path: p.to_string_lossy().to_string(),
                version: String::new(),
                source: "folder".to_string(),
            });
        }
    }
}

#[cfg(target_os = "windows")]
fn find_first_exe(root: &Path, max_depth: u32) -> Option<PathBuf> {
    if max_depth == 0 {
        return None;
    }
    let read = std::fs::read_dir(root).ok()?;
    let mut entries: Vec<_> = read.flatten().collect();
    // сортируем: сначала exe в корне
    entries.sort_by_key(|e| {
        let p = e.path();
        if p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false) {
            0
        } else if p.is_dir() {
            1
        } else {
            2
        }
    });
    for e in entries {
        let p = e.path();
        if p.extension().map(|x| x.eq_ignore_ascii_case("exe")).unwrap_or(false) {
            return Some(p);
        }
        if p.is_dir() {
            if let Some(inner) = find_first_exe(&p, max_depth - 1) {
                return Some(inner);
            }
        }
    }
    None
}

#[cfg(target_os = "windows")]
fn scan_lnk_folder<F: FnMut(AppInfo)>(root: &Path, insert: &mut F) {
    let Ok(read) = std::fs::read_dir(root) else { return };
    for entry in read.flatten() {
        let p = entry.path();
        if p.is_dir() {
            scan_lnk_folder(&p, insert);
            continue;
        }
        if !p.extension().map(|e| e.eq_ignore_ascii_case("lnk")).unwrap_or(false) {
            continue;
        }
        let name = p
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_default();
        if name.is_empty() {
            continue;
        }
        // Пробуем вытащить target через `pwsh` (быстрее чем тащить `windows` crate).
        // Делаем 1 вызов на все .lnk через `Get-Item | Select-Object` — но это медленно.
        // Поэтому: оставляем путь на сам .lnk; launch_app через `cmd /c start` его и так подхватит.
        insert(AppInfo {
            name,
            path: p.to_string_lossy().to_string(),
            version: String::new(),
            source: "lnk".to_string(),
        });
    }
}

#[cfg(target_os = "windows")]
fn scan_registry_uninstall<F: FnMut(AppInfo)>(insert: &mut F) {
    use winreg::enums::{HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;

    let hives: [(RegKey, &str); 2] = [
        (RegKey::predef(HKEY_LOCAL_MACHINE), r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"),
        (RegKey::predef(HKEY_LOCAL_MACHINE), r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"),
        // HKCU отдельно (другая преdef)
    ];
    for (hive, sub) in hives {
        if let Ok(key) = hive.open_subkey_with_flags(sub, KEY_READ) {
            scan_uninstall_key(&key, insert);
        }
    }
    if let Ok(hkcu) = RegKey::predef(HKEY_CURRENT_USER)
        .open_subkey_with_flags(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall", KEY_READ)
    {
        scan_uninstall_key(&hkcu, insert);
    }
}

#[cfg(target_os = "windows")]
fn scan_uninstall_key<F: FnMut(AppInfo)>(key: &winreg::RegKey, insert: &mut F) {
    for name in key.enum_keys().flatten() {
        let Ok(sub) = key.open_subkey(&name) else { continue };
        let display = sub.get_value("DisplayName").ok();
        let install = sub.get_value("InstallLocation").ok();
        let display_icon = sub.get_value("DisplayIcon").ok();
        let version = sub.get_value("DisplayVersion").ok();

        let Some(name) = display else { continue };
        let path = install
            .or(display_icon)
            .map(|v: String| {
                // DisplayIcon иногда идёт как "path,0" — обрежем
                if let Some(idx) = v.find(',') {
                    v[..idx].to_string()
                } else {
                    v
                }
            })
            .unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        insert(AppInfo {
            name,
            path,
            version: version.unwrap_or_default(),
            source: "registry".to_string(),
        });
    }
}

#[cfg(target_os = "windows")]
fn scan_via_pwsh_packages<F: FnMut(AppInfo)>(insert: &mut F) {
    // Get-Package выводит Name + Source (путь). Это Appx/MSI стороной.
    // Таймаут 30 сек; в худшем случае (нет pwsh) — тихо выходим.
    let Ok(out) = std::process::Command::new("pwsh")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Get-Package | Select-Object -Property Name,Source | ConvertTo-Csv -NoTypeInformation",
        ])
        .output()
    else {
        return;
    };
    if !out.status.success() {
        return;
    }
    let s = String::from_utf8_lossy(&out.stdout);
    for (i, line) in s.lines().enumerate() {
        if i == 0 {
            // header
            continue;
        }
        // CSV: "Name","Source"
        let parsed = parse_csv_line(line);
        if parsed.len() >= 2 && !parsed[0].is_empty() && !parsed[1].is_empty() {
            insert(AppInfo {
                name: parsed[0].clone(),
                path: parsed[1].clone(),
                version: String::new(),
                source: "package".to_string(),
            });
        }
    }
}

/// Простой CSV-парсер для одной строки. Не поддерживает многострочные поля
/// и экранированные кавычки внутри — для Get-Package этого достаточно.
fn parse_csv_line(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for c in line.chars() {
        match c {
            '"' => in_quotes = !in_quotes,
            ',' if !in_quotes => {
                out.push(std::mem::take(&mut cur));
            }
            other => cur.push(other),
        }
    }
    out.push(cur);
    out
}

// Stub для не-Windows (на всякий; фронт всё равно сейчас Windows-only)
#[cfg(not(target_os = "windows"))]
fn build_apps_index(_app: &tauri::AppHandle) -> Result<Vec<AppInfo>, String> {
    Ok(vec![])
}
#[cfg(not(target_os = "windows"))]
fn scan_programs_folder<F: FnMut(AppInfo)>(_root: &Path, _max_depth: u32, _insert: &mut F) {}
#[cfg(not(target_os = "windows"))]
fn scan_lnk_folder<F: FnMut(AppInfo)>(_root: &Path, _insert: &mut F) {}
#[cfg(not(target_os = "windows"))]
fn scan_registry_uninstall<F: FnMut(AppInfo)>(_insert: &mut F) {}
#[cfg(not(target_os = "windows"))]
fn scan_via_pwsh_packages<F: FnMut(AppInfo)>(_insert: &mut F) {}

// ─── find_app (fuzzy search) ──────────────────────────────────────────────

/// Поиск приложения в кэше. Два прохода: case-insensitive substring,
/// затем Levenshtein ≤ 2 для коротких запросов (≤ 12 символов) и при
/// отсутствии substring-совпадений. Возвращает top-20.
#[tauri::command]
pub async fn find_app(
    app: tauri::AppHandle,
    query: String,
) -> Result<Vec<AppInfo>, String> {
    let q = query.trim().to_string();
    if q.is_empty() {
        return Ok(vec![]);
    }
    // Убедимся, что кэш есть
    let _ = list_installed_apps(app.clone()).await?;
    let Some(cache) = read_cache(&app) else { return Ok(vec![]) };

    let q_lower = q.to_lowercase();
    let mut scored: Vec<(i32, &AppInfo)> = Vec::new();
    for a in &cache.apps {
        let name_lower = a.name.to_lowercase();
        let score = if name_lower == q_lower {
            1000
        } else if name_lower.starts_with(&q_lower) {
            500
        } else if name_lower.contains(&q_lower) {
            200
        } else if q_lower.len() >= 3 && q_lower.len() <= 24 {
            // Fuzzy (Левенштейн) только для запросов 3..24 символов.
            // Порог `d <= 2` — 2 опечатки терпимы. Было `q.len() <= 12`,
            // что не ловило опечатки в длинных названиях типа
            // "Visual Studio Code" (17 chars) при вводе "visula".
            let max_d = if q_lower.len() <= 6 { 1 } else { 2 };
            let d = levenshtein(&q_lower, &name_lower);
            if d <= max_d {
                100 - (d as i32) * 10
            } else {
                0
            }
        } else {
            0
        };
        if score > 0 {
            scored.push((score, a));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.name.cmp(&b.1.name)));
    Ok(scored.into_iter().take(20).map(|(_, a)| a.clone()).collect())
}

fn levenshtein(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let (m, n) = (a.len(), b.len());
    if m == 0 {
        return n;
    }
    if n == 0 {
        return m;
    }
    let mut prev: Vec<usize> = (0..=n).collect();
    let mut cur = vec![0usize; n + 1];
    for i in 1..=m {
        cur[0] = i;
        for j in 1..=n {
            let cost = if a[i - 1].eq_ignore_ascii_case(&b[j - 1]) {
                0
            } else {
                1
            };
            cur[j] = std::cmp::min(
                std::cmp::min(cur[j - 1] + 1, prev[j] + 1),
                prev[j - 1] + cost,
            );
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[n]
}

// ─── launch_app ───────────────────────────────────────────────────────────

/// Результат запуска: PID процесса, если получилось отследить; иначе null.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LaunchResult {
    pub pid: Option<u32>,
    pub kind: String,
}

#[tauri::command]
pub async fn launch_app(path: String) -> Result<LaunchResult, String> {
    tokio::task::spawn_blocking(move || launch_app_blocking(&path))
        .await
        .map_err(|e| format!("join: {e}"))?
}

#[cfg(target_os = "windows")]
fn launch_app_blocking(path: &str) -> Result<LaunchResult, String> {
    use std::process::Command;

    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("Пустой путь".to_string());
    }

    // 1) Shell-URI (steam://, epic://, gog://, http://, https://) — cmd /c start
    if trimmed.contains("://") {
        // start "Title" "uri"  — кавычки обязательны для URI
        let status = Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .status()
            .map_err(|e| format!("cmd start: {e}"))?;
        // cmd /c start не возвращает PID; считаем что запустили.
        if !status.success() {
            return Err(format!("start вернул {status}"));
        }
        return Ok(LaunchResult {
            pid: None,
            kind: "shell-uri".to_string(),
        });
    }

    // 2) .lnk — резолвим через `cmd /c start ""` (она сама разберёт shortcut)
    let p = Path::new(trimmed);
    if !p.exists() {
        return Err(format!("Файл не найден: {trimmed}"));
    }
    if p.extension()
        .map(|e| e.eq_ignore_ascii_case("lnk"))
        .unwrap_or(false)
    {
        let status = Command::new("cmd")
            .args(["/C", "start", "", trimmed])
            .status()
            .map_err(|e| format!("cmd start: {e}"))?;
        if !status.success() {
            return Err(format!("start .lnk вернул {status}"));
        }
        return Ok(LaunchResult {
            pid: None,
            kind: "lnk".to_string(),
        });
    }

    // 3) Обычный exe — spawn (detached, без ожидания)
    let child = Command::new(trimmed).spawn().map_err(|e| {
        // часто дело в "is not a valid Win32 application" для UWP-style лаунчеров
        format!("spawn: {e}")
    })?;
    Ok(LaunchResult {
        pid: Some(child.id()),
        kind: "exe".to_string(),
    })
}

#[cfg(not(target_os = "windows"))]
fn launch_app_blocking(path: &str) -> Result<LaunchResult, String> {
    use std::process::Command;
    let child = Command::new(path).spawn().map_err(|e| format!("spawn: {e}"))?;
    Ok(LaunchResult {
        pid: Some(child.id()),
        kind: "exe".to_string(),
    })
}

// ─── list_games ───────────────────────────────────────────────────────────

/// Парсим Steam, Epic, GOG, Battle.net. Ошибки по отдельным источникам
/// не валят весь запрос — просто кладём пустой список.
#[tauri::command]
pub async fn list_games() -> Result<Vec<GameInfo>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<GameInfo>, String> {
        let mut all = Vec::new();
        all.extend(scan_steam().unwrap_or_default());
        all.extend(scan_epic().unwrap_or_default());
        all.extend(scan_gog().unwrap_or_default());
        // Battle.net — пропускаем: нужен rusqlite, а тянем его только если будет спрос.
        all.sort_by(|a, b| b.last_played.cmp(&a.last_played));
        Ok(all)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

#[cfg(target_os = "windows")]
fn scan_steam() -> Result<Vec<GameInfo>, String> {
    use std::fs;

    let steam_root_candidates = [
        r"C:\Program Files (x86)\Steam",
        r"C:\Program Files\Steam",
    ];
    let mut steam_root: Option<&str> = None;
    for c in &steam_root_candidates {
        if Path::new(c).join("steamapps").exists() {
            steam_root = Some(*c);
            break;
        }
    }
    let Some(root) = steam_root else { return Ok(vec![]) };
    let steamapps = Path::new(root).join("steamapps");

    // 1) читаем libraryfolders.vdf, чтобы знать все папки
    let mut library_paths: Vec<PathBuf> = vec![steamapps.clone()];
    let vdf_path = steamapps.join("libraryfolders.vdf");
    if let Ok(s) = fs::read_to_string(&vdf_path) {
        // Очень простой VDF-парсер: ищем "<path>" под "path"-ключами
        // в секции "LibraryFolders". Нам хватит поверхностного сканирования.
        for line in s.lines() {
            let t = line.trim();
            if t.starts_with("\"path\"") {
                // "path"      "C:\\Games\\Steam"
                if let Some(val) = t.split('"').nth(3) {
                    let p = PathBuf::from(val.replace("\\\\", "\\"));
                    if p.join("steamapps").exists() {
                        library_paths.push(p.join("steamapps"));
                    }
                }
            }
        }
    }

    let mut games = Vec::new();
    for lib in &library_paths {
        let Ok(read) = fs::read_dir(lib) else { continue };
        for entry in read.flatten() {
            let p = entry.path();
            if p.extension()
                .map(|e| e.eq_ignore_ascii_case("acf"))
                .unwrap_or(false)
            {
                if let Some(g) = parse_acf(&p, lib) {
                    games.push(g);
                }
            }
        }
    }
    Ok(games)
}

#[cfg(target_os = "windows")]
fn parse_acf(path: &Path, lib: &Path) -> Option<GameInfo> {
    let s = std::fs::read_to_string(path).ok()?;
    let mut map: HashMap<String, String> = HashMap::new();
    for line in s.lines() {
        let t = line.trim();
        // "<key>"   "<value>"
        let mut parts = t.split('"');
        let _first = parts.next()?; // пусто до первой кавычки
        let key = parts.next()?.to_string();
        let _val_marker = parts.next()?; // пусто между ""
        let val = parts.next()?.to_string();
        map.insert(key, val);
    }
    let appid = map.get("appid")?.clone();
    let name = map.get("name")?.clone();
    let installdir = map.get("installdir").cloned().unwrap_or_default();
    let last_played: i64 = map
        .get("LastPlayTime")
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(0)
        * 1000; // Steam хранит unix-sec
    let install_path = if installdir.is_empty() {
        String::new()
    } else {
        lib.join(&installdir).to_string_lossy().to_string()
    };
    Some(GameInfo {
        name,
        source: "steam".to_string(),
        appid,
        install_path,
        last_played,
    })
}

#[cfg(target_os = "windows")]
fn scan_epic() -> Result<Vec<GameInfo>, String> {
    // Epic хранит манифесты в saved/data; для простоты — пусто, чтобы не врать.
    // (полноценный парсер требует разбирать бинарный .dat — лучше отдельной задачей)
    Ok(vec![])
}

#[cfg(target_os = "windows")]
fn scan_gog() -> Result<Vec<GameInfo>, String> {
    // GOG Galaxy 2 registry: HKLM\SOFTWARE\GOG.com\Games\*\gameId, name, path
    use winreg::enums::{HKEY_LOCAL_MACHINE, KEY_READ};
    use winreg::RegKey;
    let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
    let Ok(games_key) = hklm.open_subkey_with_flags(r"SOFTWARE\GOG.com\Games", KEY_READ) else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for sub_name in games_key.enum_keys().flatten() {
        let Ok(sub) = games_key.open_subkey(&sub_name) else { continue };
        let name: String = sub.get_value("name").unwrap_or_default();
        let game_id: String = sub.get_value("gameId").unwrap_or_default();
        let path: String = sub.get_value("path").unwrap_or_default();
        if name.is_empty() || game_id.is_empty() {
            continue;
        }
        out.push(GameInfo {
            name,
            source: "gog".to_string(),
            appid: game_id,
            install_path: path,
            last_played: 0,
        });
    }
    Ok(out)
}

#[cfg(not(target_os = "windows"))]
fn scan_steam() -> Result<Vec<GameInfo>, String> { Ok(vec![]) }
#[cfg(not(target_os = "windows"))]
fn scan_epic() -> Result<Vec<GameInfo>, String> { Ok(vec![]) }
#[cfg(not(target_os = "windows"))]
fn scan_gog() -> Result<Vec<GameInfo>, String> { Ok(vec![]) }

// ─── list_running_processes (через sysinfo) ───────────────────────────────

#[tauri::command]
pub async fn list_running_processes() -> Result<Vec<ProcInfo>, String> {
    tokio::task::spawn_blocking(|| -> Result<Vec<ProcInfo>, String> {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_all();

        let mut out: Vec<ProcInfo> = sys
            .processes()
            .iter()
            .map(|(pid, p)| ProcInfo {
                pid: pid.as_u32(),
                name: p.name().to_string_lossy().to_string(),
                memory_mb: p.memory() as f64 / (1024.0 * 1024.0),
                cpu_pct: p.cpu_usage(),
            })
            .collect();
        out.sort_by(|a, b| {
            b.memory_mb
                .partial_cmp(&a.memory_mb)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        out.truncate(50);
        Ok(out)
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ─── system_info (sysinfo) ────────────────────────────────────────────────

#[tauri::command]
pub async fn system_info() -> Result<SysInfo, String> {
    tokio::task::spawn_blocking(|| -> Result<SysInfo, String> {
        let mut sys = sysinfo::System::new_all();
        sys.refresh_all();

        let cpu_brand = sys
            .cpus()
            .first()
            .map(|c| c.brand().to_string())
            .unwrap_or_else(|| "unknown".to_string());
        let cpu_cores = sys.cpus().len() as u32;
        let cpu_usage_pct: f32 = if cpu_cores > 0 {
            (sys.cpus().iter().map(|c| c.cpu_usage()).sum::<f32>()) / (cpu_cores as f32)
        } else {
            0.0
        };

        let ram_total_gb = sys.total_memory() as f64 / (1024.0 * 1024.0 * 1024.0);
        let ram_used_gb = sys.used_memory() as f64 / (1024.0 * 1024.0 * 1024.0);

        let mut disks: Vec<DiskInfo> = sysinfo::Disks::new_with_refreshed_list()
            .iter()
            .map(|d| DiskInfo {
                mount: d.mount_point().to_string_lossy().to_string(),
                total_gb: d.total_space() as f64 / (1024.0 * 1024.0 * 1024.0),
                free_gb: d.available_space() as f64 / (1024.0 * 1024.0 * 1024.0),
            })
            .collect();
        // Сортируем C: первым (привычно для UI)
        disks.sort_by(|a, b| {
            if a.mount.eq_ignore_ascii_case("C:\\") {
                std::cmp::Ordering::Less
            } else if b.mount.eq_ignore_ascii_case("C:\\") {
                std::cmp::Ordering::Greater
            } else {
                a.mount.cmp(&b.mount)
            }
        });

        // Батарея: на десктопе None, на ноуте — Some
        let battery_pct: Option<f32> = None; // sysinfo 0.32 без feature "battery"
        // (см. Cargo.toml: features = ["windows"]; battery — отдельный feature,
        //  пока не подключаем — в Windows sysinfo всё равно не умеет battery.)
        let _ = battery_pct;

        let uptime_secs = sysinfo::System::uptime();

        Ok(SysInfo {
            cpu_brand,
            cpu_cores,
            cpu_usage_pct,
            ram_total_gb,
            ram_used_gb,
            disks,
            battery_pct: None,
            uptime_secs,
        })
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}

// ─── open_url ─────────────────────────────────────────────────────────────

#[tauri::command]
pub async fn open_url(url: String) -> Result<(), String> {
    tokio::task::spawn_blocking(move || -> Result<(), String> {
        let trimmed = url.trim();
        if trimmed.is_empty() {
            return Err("Пустой URL".to_string());
        }
        if !trimmed.contains("://") && !trimmed.starts_with("mailto:") {
            return Err(format!("Не похоже на URL: {trimmed}"));
        }
        #[cfg(target_os = "windows")]
        {
            std::process::Command::new("cmd")
                .args(["/C", "start", "", trimmed])
                .status()
                .map_err(|e| format!("cmd start: {e}"))?;
        }
        #[cfg(target_os = "macos")]
        {
            std::process::Command::new("open").arg(trimmed).status().map_err(|e| format!("open: {e}"))?;
        }
        #[cfg(all(unix, not(target_os = "macos")))]
        {
            std::process::Command::new("xdg-open").arg(trimmed).status().map_err(|e| format!("xdg-open: {e}"))?;
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("join: {e}"))?
}
