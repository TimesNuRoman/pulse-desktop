// SPDX-License-Identifier: Apache-2.0
// Pulse — R119 PRO license module (Rust side).
//
// Этот модуль — owner файла `license.bin` в `app_data_dir()`. R119 scope:
//   * license_read()  — прочитать raw bytes (зашифровано JS-стороной).
//   * license_write() — записать raw bytes (от JS после WebCrypto-encrypt).
//   * license_clear() — удалить файл.
//   * license_ping()  — format check + dev-mode test key bypass; R120+
//                       заменим на реальный server ping.
//
// R120+ roadmap:
//   * Реальный Polar.sh webhook (HTTP fetch в Rust).
//   * Machine fingerprint через `tauri-plugin-machine-id` (или syscall).
//   * Grace period bookkeeping на server-side.
//
// Architectural decision (PULSE-PRO-ARCHITECTURE-2026-08-02.md):
//   * НЕ валидируем ключ через Ed25519 на клиенте (Roman dropped 2026-08-02).
//   * Ключ = opaque bearer token. Rust делает только format check.
//   * Реальная валидность = server ping (R120).
//
// Path: `app_data_dir()/license.bin`. На Windows = `%APPDATA%\Pulse\license.bin`.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// Файл лицензии в `app_data_dir()`. Содержит зашифрованный через WebCrypto
/// (AES-256-GCM) JSON с state machine'ом (см. web/src/lib/license/store.ts).
const LICENSE_FILENAME: &str = "license.bin";

/// Результат license_ping: подтверждение что ключ валиден по формату.
/// R119 stub: server ping не делаем (format-valid = OK).
/// R120: добавим `verifiedAt: ISO-timestamp` + реальный fetch.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct LicensePingResult {
    /// true если ключ прошёл format check.
    pub valid: bool,
    /// 'free' или 'pro'.
    pub tier: String,
    /// Unix-ms exp returned by server. None = no expiry (dev mode).
    pub expires_at: Option<i64>,
    /// Сообщение об ошибке (если valid=false).
    pub error: Option<String>,
}

/// Путь к файлу лицензии. Создаёт parent dir лениво.
pub fn license_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("app_data_dir: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("create_dir_all({dir:?}): {e}"))?;
    Ok(dir.join(LICENSE_FILENAME))
}

/// Прочитать `license.bin` (raw bytes). None если файла нет.
pub fn read_license(app: &AppHandle) -> Result<Option<Vec<u8>>, String> {
    let path = license_path(app)?;
    match std::fs::read(&path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {path:?}: {e}")),
    }
}

/// Записать `license.bin` атомарно (tmp + rename). Если Tauri упадёт посреди
/// write — файл останется целым (атомарность важна: corrupt license = user
/// locked out of PRO).
pub fn write_license(app: &AppHandle, bytes: &[u8]) -> Result<(), String> {
    let path = license_path(app)?;
    let tmp = path.with_extension("bin.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("write tmp {tmp:?}: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("rename: {e}"))?;
    Ok(())
}

/// Удалить `license.bin`. No-op если файла нет.
pub fn clear_license(app: &AppHandle) -> Result<(), String> {
    let path = license_path(app)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(format!("remove {path:?}: {e}")),
    }
}

// ─── Format validation (defense-in-depth) ──────────────────────────────────

/// Regex для production-формат ключа. Должен совпадать с TS версией в
/// `web/src/lib/license/validate.ts::LICENSE_KEY_REGEX`.
///   PULSE-XXXX-XXXX-XXXX-XXXX-XXXX
///   4-char base32 chunks, без 0/O/1/I/L (lookalikes).
fn is_valid_key_format(key: &str) -> bool {
    if key.len() != 30 {
        return false;
    }
    let bytes = key.as_bytes();
    if &bytes[0..6] != b"PULSE-" {
        return false;
    }
    for &start in &[6usize, 11, 16, 21, 26] {
        for i in 0..4 {
            if !is_allowed_base32_char(bytes[start + i]) {
                return false;
            }
        }
    }
    true
}

/// Один символ из allowed alphabet: 2-9, A-H, J-K, M-N, P-Z.
fn is_allowed_base32_char(b: u8) -> bool {
    matches!(b, b'2'..=b'9' | b'A'..=b'H' | b'J'..=b'K' | b'M'..=b'N' | b'P'..=b'Z')
}

/// Hardcoded test key (special-case bypass). Должен совпадать с TS
/// `web/src/lib/license/validate.ts::TEST_KEY`.
const TEST_KEY: &str = "PULSE-TEST1-TEST1-TEST1-TEST1-TEST1";

/// Normalized form of the test key (dashes stripped, uppercase).
/// `is_test_key` compares against this after running the input through
/// `normalize_key`. Keeping it as a separate const documents the assumption.
const TEST_KEY_NORMALIZED: &str = "PULSETEST1TEST1TEST1TEST1TEST1";

fn is_test_key(normalized: &str) -> bool {
    normalized == TEST_KEY_NORMALIZED
}

fn normalize_key(key: &str) -> String {
    key.replace([' ', '-'], "").to_uppercase()
}

// ─── Tauri commands ────────────────────────────────────────────────────────

/// Read `license.bin` (raw bytes). Returns None if the file does not exist.
/// JS-сторона расшифрует WebCrypto.
#[tauri::command]
pub fn license_read(app: AppHandle) -> Result<Option<Vec<u8>>, String> {
    read_license(&app)
}

/// Write `license.bin` (raw bytes from JS after WebCrypto encryption).
/// Атомарная запись (tmp + rename).
#[tauri::command]
pub fn license_write(app: AppHandle, bytes: Vec<u8>) -> Result<(), String> {
    write_license(&app, &bytes)
}

/// Delete `license.bin` (deactivate).
#[tauri::command]
pub fn license_clear(app: AppHandle) -> Result<(), String> {
    clear_license(&app)
}

/// Verify license key (R119 stub).
/// R120: реальный Polar.sh webhook + signed response.
#[tauri::command]
pub fn license_ping(key: String) -> LicensePingResult {
    // 1) Test key bypass — compare against the dashless normalized form so
    //    any whitespace/dash input still matches.
    if is_test_key(&normalize_key(&key)) {
        return LicensePingResult {
            valid: true,
            tier: "pro".into(),
            expires_at: None,
            error: None,
        };
    }

    // 2) Format check on the original (dash-preserving) form, uppercased
    //    and trimmed. `is_valid_key_format` requires the exact 30-char
    //    PULSE-XXXX-XXXX-XXXX-XXXX-XXXX layout.
    let cleaned = key.trim().to_uppercase();
    if !is_valid_key_format(&cleaned) {
        return LicensePingResult {
            valid: false,
            tier: "free".into(),
            expires_at: None,
            error: Some(
                "Invalid license key format. Expected PULSE-XXXX-XXXX-XXXX-XXXX-XXXX \
                 (4-char base32 chunks, no 0/O/1/I/L)."
                    .into(),
            ),
        };
    }

    // 3) R119 stub: format-valid = OK. R120: реальный server ping.
    LicensePingResult {
        valid: true,
        tier: "pro".into(),
        expires_at: None,
        error: None,
    }
}

// ─── Tests (cargo test) ────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn is_valid_key_format_accepts_canonical() {
        assert!(is_valid_key_format("PULSE-2345-6789-ABCD-EFGH-JKMN"));
        assert!(is_valid_key_format("PULSE-AAAA-BBBB-CCCC-DDDD-EEEE"));
    }

    #[test]
    fn is_valid_key_format_rejects_excluded_chars() {
        // 0, O, 1, I, L — все excluded.
        assert!(!is_valid_key_format("PULSE-0EST-2EST-3EST-4EST-5EST"));
        assert!(!is_valid_key_format("PULSE-OEST-2EST-3EST-4EST-5EST"));
        assert!(!is_valid_key_format("PULSE-IEST-2EST-3EST-4EST-5EST"));
        assert!(!is_valid_key_format("PULSE-LEST-2EST-3EST-4EST-5EST"));
        assert!(!is_valid_key_format("PULSE-1EST-2EST-3EST-4EST-5EST"));
    }

    #[test]
    fn is_valid_key_format_rejects_wrong_length() {
        assert!(!is_valid_key_format("PULSE-2345-6789-ABCD-EFGH"));
        assert!(!is_valid_key_format("PULSE-2345-6789-ABCD-EFGH-JKMN-XXXX"));
        assert!(!is_valid_key_format(""));
    }

    #[test]
    fn is_valid_key_format_rejects_wrong_prefix() {
        assert!(!is_valid_key_format("XPULS-2345-6789-ABCD-EFGH-JKMN"));
        assert!(!is_valid_key_format("pulse-2345-6789-ABCD-EFGH-JKMN"));
    }

    #[test]
    fn is_test_key_recognizes_hardcoded() {
        assert!(is_test_key(TEST_KEY_NORMALIZED));
        assert!(!is_test_key("PULSE-2345-6789-ABCD-EFGH-JKMN"));
    }

    #[test]
    fn normalize_key_strips_dashes_and_spaces() {
        assert_eq!(
            normalize_key("  pulse-test1-test1-test1-test1-test1  "),
            "PULSETEST1TEST1TEST1TEST1TEST1"
        );
    }

    #[test]
    fn license_ping_test_key() {
        let r = license_ping(TEST_KEY.into());
        assert!(r.valid);
        assert_eq!(r.tier, "pro");
        assert!(r.error.is_none());
    }

    #[test]
    fn license_ping_rejects_garbage() {
        let r = license_ping("garbage".into());
        assert!(!r.valid);
        assert_eq!(r.tier, "free");
        assert!(r.error.is_some());
    }

    #[test]
    fn license_ping_accepts_format_valid_stub() {
        let r = license_ping("PULSE-2345-6789-ABCD-EFGH-JKMN".into());
        assert!(r.valid);
        assert_eq!(r.tier, "pro");
    }
}
