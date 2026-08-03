// Pulse Setup Wizard — Phase 1: hardware detection.
//
// Спроектировано в `~/.minimax/plans/pulse-setup-wizard-design.md`.
// Используется Setup Wizard-ом на фронте (Phase 2: UI) для выбора
// подходящего Ollama + модели под железо юзера.
//
// MVP: CPU/RAM/Disk через `sysinfo` + `os_info`.
// P1 (отложено): GPU через WMI (Windows) / NVML (NVIDIA) / Metal (macOS)
//     под feature-флагом `gpu-detect`. Тип `GpuInfo` уже готов.

use serde::{Deserialize, Serialize};

// R175: `detect.rs` (содержит `os_info::get()`) намеренно НЕ подключён как
// подмодуль — крейт `os_info` отсутствует в Cargo.toml, и brief запрещает
// добавлять новые Rust-зависимости. Реализация `detect_hardware()` живёт
// inline в `lib.rs::detect_hardware_blocking` (R175). detect.rs остаётся на
// диске как dead code для будущего R-round-а, который добавит os_info.

// ─── публичные типы (serde, чтобы фронт получил готовый JSON) ─────────────

/// Полный снимок железа и рекомендованный тариф для Ollama-модели.
/// Сериализуется в JSON и уходит в TS-обёртку фронта (Phase 2).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HardwareSpec {
    pub os: OsInfo,
    /// Архитектура процессора (x86_64 / aarch64). Дублируется в `os.arch`
    /// для удобства TS-зеркала, но приходит из `std::env::consts::ARCH`.
    pub arch: String,
    pub cpu: CpuInfo,
    pub ram: RamInfo,
    pub disk: DiskInfo,
    /// MVP: всегда пустой. P1 — WMI/NVML/Metal.
    pub gpus: Vec<GpuInfo>,
    pub recommended_tier: Tier,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OsInfo {
    /// "Windows" / "Linux" / "Mac OS" (os_info::os_type).
    pub name: String,
    /// "10.0.22631" (os_info::version).
    pub version: String,
    /// Ядро ОС: "10.0.22631" / "6.5.0-15-generic" / "Darwin Kernel 23.5.0".
    pub kernel: String,
    /// "x86_64" / "aarch64" / и т.п.
    pub arch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CpuInfo {
    /// "AMD Ryzen 7 5800X" / "Intel Core i7-13700K" / "Apple M2 Pro".
    pub brand: String,
    /// Физических ядер (без hyperthreading).
    pub cores: u32,
    /// Логических ядер = потоки. На Intel/AMD с SMT обычно = 2 * cores.
    pub threads: u32,
    /// Базовая частота в МГц (без boost).
    pub frequency_mhz: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RamInfo {
    pub total_gb: f32,
    pub available_gb: f32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiskInfo {
    /// Свободно на самом ёмком диске (под модели Ollama).
    pub free_gb: f32,
    pub total_gb: f32,
    /// "C:\\" (Windows) или "/" (Unix). Используется фронтом для UI-подсказок.
    pub mount_point: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuInfo {
    /// "NVIDIA" | "AMD" | "Intel" | "Apple" | "Unknown".
    pub vendor: String,
    /// "RTX 3060" / "M2 Pro" / "Intel UHD 770".
    pub name: String,
    /// Видеопамять в ГБ. `None` для интегрированных (берёт RAM).
    pub vram_gb: Option<u32>,
    pub driver_version: Option<String>,
    /// ["CUDA 12.4", "Vulkan 1.3"] / ["Metal 3"] / ["ROCm 5.7"].
    pub api: Vec<String>,
}

/// Тариф железа, на основе которого Setup Wizard подбирает Ollama-модели.
/// Границы подобраны под актуальные модели Ollama (конец 2024 — 2026):
///   Low    — phi3:mini / gemma2:2b (CPU-only, 4-bit квантизация)
///   Mid    — llama3.1:8b / mistral:7b (CPU+слабая GPU)
///   High   — llama3.1:8b-q4_K_M на GPU / qwen2.5:14b на CPU
///   Ultra  — llama3.1:70b-q3 / mixtral:8x22b
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum Tier {
    Low,    // 4GB RAM, 0 VRAM
    Mid,    // 8-16GB RAM, 0-4GB VRAM
    High,   // 16-32GB RAM, 4-8GB VRAM
    Ultra,  // 32GB+ RAM, 8GB+ VRAM
}

impl Default for Tier {
    fn default() -> Self {
        // Safe middle: ничего не утверждаем, но и не упираемся в Low.
        Tier::Low
    }
}

impl Default for OsInfo {
    fn default() -> Self {
        Self {
            name: "unknown".to_string(),
            version: String::new(),
            kernel: String::new(),
            arch: std::env::consts::ARCH.to_string(),
        }
    }
}

impl Default for CpuInfo {
    fn default() -> Self {
        Self {
            brand: "unknown".to_string(),
            cores: 0,
            threads: 0,
            frequency_mhz: 0,
        }
    }
}

impl Default for RamInfo {
    fn default() -> Self {
        Self { total_gb: 0.0, available_gb: 0.0 }
    }
}

impl Default for DiskInfo {
    fn default() -> Self {
        Self { free_gb: 0.0, total_gb: 0.0, mount_point: String::new() }
    }
}

impl Default for HardwareSpec {
    /// R175: best-effort default, если detect_hardware() вернул Err.
    /// На фронт уйдёт «unknown» CPU / 0 GB RAM / Low tier — UI покажет
    /// заглушку вместо падения.
    fn default() -> Self {
        Self {
            arch: std::env::consts::ARCH.to_string(),
            os: OsInfo::default(),
            cpu: CpuInfo::default(),
            ram: RamInfo::default(),
            disk: DiskInfo::default(),
            gpus: Vec::new(),
            recommended_tier: Tier::Low,
        }
    }
}
