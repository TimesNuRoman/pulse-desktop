// A/B log — append-only JSONL writer с 7-дневной ротацией.
//
// Формат строки (одна JSON на строку):
//   {"ts":1700000000000,"task_id":"code-01","category":"code-edit",
//    "path":"v3","model":"code","latency_ms":234,"passed":true,
//    "score":12,"fired":["code-edit","long"],"chars":612}
//
// Ротация: при append проверяем mtime файла; если старше 7 дней —
// переименовываем в `ab-YYYYMMDD.jsonl` и стартуем новый. Это простая
// size-based + time-based: keep last 7 days, no size cap (файл A/B лога
// маленький — 50 строк ~ 10 KB, годовой объем < 5 MB).
//
// `ab_log_path()` — default location: Pulse app_data_dir / "ab.jsonl".
// В тестах override'им через `AbLogWriter::at(path)`.

use serde::{Deserialize, Serialize};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Одна строка A/B лога.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AbLogEntry {
    /// Unix-ms
    pub ts: i64,
    /// Уникальный ID задачи (напр. "code-01", "reason-12")
    pub task_id: String,
    /// Категория
    pub category: String,
    /// Какой путь отработал: "v3" (Smart Engine) или "gemma3:4b" (baseline)
    pub path: String,
    /// Какая модель была использована (preferred, либо baseline)
    pub model: String,
    /// Latency в миллисекундах
    pub latency_ms: u64,
    /// Прошла ли проверка
    pub passed: bool,
    /// Score из EngineDecision
    pub score: i32,
    /// Список сработавших условий
    pub fired: Vec<String>,
    /// Длина user-промпта в символах
    pub chars: usize,
    /// Текст ответа (для дебага; не логируется в проде по умолчанию)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub response_excerpt: Option<String>,
}

const ROTATION_DAYS: u64 = 7;
const ROTATION_MS: u64 = ROTATION_DAYS * 24 * 60 * 60 * 1000;

/// A/B-лог writer. Хранит handle на файл + путь, делает lazy open + rotate.
pub struct AbLogWriter {
    path: PathBuf,
}

impl AbLogWriter {
    /// Открыть writer на конкретном пути. Создаёт parent dir при необходимости.
    pub fn at(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        Self { path }
    }

    /// Default-расположение: `./data/ab.jsonl` относительно CWD, или
    /// override через env `PULSE_AB_LOG`.
    pub fn default_path() -> PathBuf {
        if let Ok(p) = std::env::var("PULSE_AB_LOG") {
            return PathBuf::from(p);
        }
        // Pulse v0.5.2: app_data_dir/../data/ab.jsonl (вне AppData — доступнее для grep'а)
        let cwd_data = std::env::current_dir()
            .ok()
            .map(|d| d.join("data").join("ab.jsonl"));
        cwd_data.unwrap_or_else(|| PathBuf::from("data/ab.jsonl"))
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Записать одну запись (JSON + \n). Перед записью — rotate если пора.
    pub fn write(&self, entry: &AbLogEntry) -> std::io::Result<()> {
        self.rotate_if_needed()?;
        let mut f = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        let line = serde_json::to_string(entry)
            .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
        writeln!(f, "{}", line)?;
        Ok(())
    }

    /// Прочитать все записи (для анализа). Возвращает Ok(vec) даже если файла нет.
    pub fn read_all(&self) -> std::io::Result<Vec<AbLogEntry>> {
        if !self.path.exists() {
            return Ok(Vec::new());
        }
        let content = fs::read_to_string(&self.path)?;
        let mut out = Vec::new();
        for line in content.lines() {
            if line.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<AbLogEntry>(line) {
                Ok(e) => out.push(e),
                Err(_) => {
                    // Пропускаем битые строки (best-effort)
                    continue;
                }
            }
        }
        Ok(out)
    }

    /// Ротация: если файл старше 7 дней, переименовать в ab-YYYYMMDD.jsonl.
    fn rotate_if_needed(&self) -> std::io::Result<()> {
        if !self.path.exists() {
            return Ok(());
        }
        let meta = fs::metadata(&self.path)?;
        let modified = meta.modified().ok();
        let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default();
        let age_ms = match modified {
            Some(m) => now.saturating_sub(m.duration_since(UNIX_EPOCH).unwrap_or_default()),
            None => std::time::Duration::from_millis(0),
        };
        if age_ms < std::time::Duration::from_millis(ROTATION_MS) {
            return Ok(());
        }
        // Переименовать с датой
        let secs = now.as_secs();
        // Грубая дата из unix-seconds (без chrono dep).
        // 1970-01-01 — четверг. Days since epoch.
        let days = secs / 86_400;
        // Алгоритм: https://en.wikipedia.org/wiki/Julian_day#Julian_day_number
        let (y, m, d) = days_to_ymd(days as i64);
        let archived = self
            .path
            .with_file_name(format!("ab-{:04}{:02}{:02}.jsonl", y, m, d));
        // Если уже есть файл с такой датой — дописываем в него (не перезаписываем)
        if !archived.exists() {
            fs::rename(&self.path, &archived)?;
        } else {
            // Уже ротирован сегодня — оставляем как есть, новые строки пойдут в текущий
        }
        Ok(())
    }
}

/// Unix-days -> (year, month, day). Простая реализация без chrono.
fn days_to_ymd(days_since_epoch: i64) -> (i32, u32, u32) {
    // Алгоритм: Howard Hinnant `civil_from_days`
    let z = days_since_epoch + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u32; // [0, 146_096]
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365; // [0, 399]
    let y = (yoe as i32) + (era as i32) * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100); // [0, 365]
    let mp = (5 * doy + 2) / 153; // [0, 11]
    let d = doy - (153 * mp + 2) / 5 + 1; // [1, 31]
    let m = if mp < 10 { mp + 3 } else { mp - 9 }; // [1, 12]
    let y = if m <= 2 { y + 1 } else { y };
    (y, m, d)
}

/// Публичный helper для удобства вызывающих.
pub fn ab_log_path() -> PathBuf {
    AbLogWriter::default_path()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn days_to_ymd_epoch() {
        // 1970-01-01
        assert_eq!(days_to_ymd(0), (1970, 1, 1));
        // 2000-01-01 = 10957 days
        assert_eq!(days_to_ymd(10957), (2000, 1, 1));
        // 2026-08-01
        // 1970..2026-08-01 = 56*365 + 14 leap days (1972,76,80,84,88,92,96,2000,04,08,12,16,20,24)
        // = 20440 + 14 = 20454... let me just check 2026-01-01 = 20454 days
        assert_eq!(days_to_ymd(20454), (2026, 1, 1));
    }

    #[test]
    fn write_and_read_roundtrip() {
        let dir = std::env::temp_dir().join(format!("pulse-ab-test-{}", std::process::id()));
        let _ = fs::create_dir_all(&dir);
        let path = dir.join("ab.jsonl");
        let _ = fs::remove_file(&path);

        let w = AbLogWriter::at(path.clone());
        let entry = AbLogEntry {
            ts: 1_700_000_000_000,
            task_id: "test-01".to_string(),
            category: "code-edit".to_string(),
            path: "v3".to_string(),
            model: "code".to_string(),
            latency_ms: 234,
            passed: true,
            score: 12,
            fired: vec!["code-edit".into(), "long".into()],
            chars: 612,
            response_excerpt: Some("fn main() {}".into()),
        };
        w.write(&entry).unwrap();

        let all = w.read_all().unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].task_id, "test-01");
        assert!(all[0].passed);
        assert_eq!(all[0].fired.len(), 2);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn read_missing_file_returns_empty() {
        let w = AbLogWriter::at("/nonexistent/path/ab.jsonl");
        let all = w.read_all().unwrap();
        assert!(all.is_empty());
    }
}
