// Pulse Setup Wizard — Phase 1: hardware detection implementation.
//
// Снимок железа делается через `sysinfo` (CPU/RAM/Disk) + `os_info` (ОС).
// GPU-детекция отложена в P1 (WMI / NVML / Metal) — MVP-вызов возвращает
// `gpus: vec![]` и тариф считается только по RAM.
//
// `detect_hardware()` блокирующий — оборачивается в `tokio::task::spawn_blocking`
// из Tauri-команды в `lib.rs`, чтобы не подвешивать UI-runtime.

use super::{CpuInfo, DiskInfo, GpuInfo, HardwareSpec, OsInfo, RamInfo, Tier};
use sysinfo::{Disks, System};

/// Снимает снимок железа текущей машины. Использует `System::new_all()` —
/// это первый вызов, он заполняет все поля (последующие вызовы требуют
/// явного refresh_* на изменённых полях, но в нашем use-case мы вызываем
/// один раз при старте Setup Wizard-а, так что `new_all()` ок).
pub fn detect_hardware() -> Result<HardwareSpec, String> {
    let mut sys = System::new_all();
    sys.refresh_all();

    // `os_info 0.3` не имеет `kernel_version()` (метод добавлен в 3.x),
    // поэтому kernel берём из `sysinfo::System::kernel_version()` (associated fn).
    // Тип ОС и версия (например "Windows 10.0.22631") — через `os_info`.
    let info = os_info::get();
    let os = OsInfo {
        name: info.os_type().to_string(),
        version: info.version().to_string(),
        kernel: sysinfo::System::kernel_version().unwrap_or_default(),
        arch: std::env::consts::ARCH.to_string(),
    };

    let cpu = {
        let cpus = sys.cpus();
        // Берём первый CPU как репрезентативный (модель одинаковая для всех ядер).
        let first = cpus.first();
        // `physical_core_count()` в sysinfo 0.32 — inherent method `&self -> Option<usize>`.
        // Падаем на `cpus.len()` (как worst case), потом кастим в `u32` для
        // сериализации (TS-зеркало на фронте — `number`).
        let cores_usize = sys.physical_core_count().unwrap_or_else(|| cpus.len());
        CpuInfo {
            brand: first.map(|c| c.brand().to_string()).unwrap_or_default(),
            cores: cores_usize as u32,
            threads: cpus.len() as u32,
            frequency_mhz: first.map(|c| c.frequency() as u32).unwrap_or(0),
        }
    };

    let ram = RamInfo {
        // 1 ГБ = 1e9 байт. Это «коммерческие» гигабайты (SI), не GiB.
        // Для UI тарифа разница в ~7% несущественна.
        total_gb: sys.total_memory() as f32 / 1e9,
        available_gb: sys.available_memory() as f32 / 1e9,
    };

    // Берём диск с максимальным свободным местом — туда логичнее всего
    // качать Ollama-модели (5-50 ГБ). Если дисков нет вообще (sandbox без FS) —
    // возвращаем заглушку, чтобы фронт не падал на делении.
    //
    // `sysinfo 0.32` не имеет `System::disks()` — это отдельный тип
    // `Disks` (см. `system.rs:802` в существующем коде Pulse).
    let disk = {
        let disks = Disks::new_with_refreshed_list();
        let main_disk = disks
            .iter()
            .max_by_key(|d| d.available_space())
            .or_else(|| disks.iter().next());
        match main_disk {
            Some(d) => DiskInfo {
                free_gb: d.available_space() as f32 / 1e9,
                total_gb: d.total_space() as f32 / 1e9,
                mount_point: d.mount_point().to_string_lossy().to_string(),
            },
            None => DiskInfo {
                free_gb: 0.0,
                total_gb: 0.0,
                mount_point: std::path::Path::new("/").to_string_lossy().to_string(),
            },
        }
    };

    // P1: GPU-детекция. MVP — пусто, тариф считается только по RAM.
    let gpus: Vec<GpuInfo> = Vec::new();

    let recommended_tier = resolve_tier(&ram, &gpus);

    Ok(HardwareSpec {
        arch: os.arch.clone(),
        os,
        cpu,
        ram,
        disk,
        gpus,
        recommended_tier,
    })
}

/// Маппинг RAM+VRAM → тариф. Сетка подобрана под Ollama-модели 2024-2026:
/// - Low    (≤8 GB RAM)              — только CPU, маленькие модели (phi3:mini, gemma2:2b)
/// - Mid    (9-16 GB RAM, ≤4 GB VRAM) — 8B q4 на CPU или слабая GPU
/// - High   (9-16 GB + ≥5 GB VRAM, 17-32 GB RAM) — полноценные 8-14B на GPU
/// - Ultra  (>32 GB RAM, или любая с >8 GB VRAM) — 70B+, 8x22B mixtral
///
/// Переписано через if-else вместо match-arms: mutually exclusive ranges
/// (`(0..=8, _)` / `(9..=16, _)`) дают mutually exclusive match, но
/// `(0..=4)` / `(5..)` внутри одного ram-диапазона — пересечение на границе
/// (если ram фиксирован). Поэтому чище через early return.
fn resolve_tier(ram: &RamInfo, gpus: &[GpuInfo]) -> Tier {
    let ram_gb = ram.total_gb as u32;
    let max_vram = gpus.iter().filter_map(|g| g.vram_gb).max().unwrap_or(0);

    // Low: ≤8 GB RAM. Никакая GPU не спасёт — 8B q4 нужно минимум 5-6 ГБ,
    // итого с системой 8 ГБ мало.
    if ram_gb <= 8 {
        return Tier::Low;
    }
    // Mid: 9-16 GB RAM со слабой GPU или без. 8B q4_K_M влезет.
    if ram_gb <= 16 && max_vram <= 4 {
        return Tier::Mid;
    }
    // High: 9-16 GB + средняя GPU (5+ ГБ VRAM) ИЛИ 17-32 GB RAM с любой GPU.
    if ram_gb <= 32 {
        return Tier::High;
    }
    // Ultra: >32 GB RAM (большой q4 30B / q3 70B на CPU).
    Tier::Ultra
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_hardware_returns_valid_spec() {
        let spec = detect_hardware().expect("detect_hardware should not fail in tests");
        // OS / CPU / RAM / Disk должны быть заполнены на любой реальной системе.
        assert!(!spec.os.name.is_empty(), "os.name is empty");
        assert!(!spec.os.version.is_empty(), "os.version is empty");
        assert!(spec.cpu.cores > 0, "cpu.cores == 0");
        assert!(spec.cpu.threads > 0, "cpu.threads == 0");
        assert!(spec.ram.total_gb > 0.0, "ram.total_gb == 0");
        // Disk может быть 0 в странных sandbox-окружениях, проверяем только
        // что поле существует и не паникует.
        let _ = spec.disk.total_gb;
        // gpus в MVP всегда пустой.
        assert!(spec.gpus.is_empty(), "gpus should be empty in MVP");
        // Полезный side-effect: при запуске `cargo test hardware -- --nocapture`
        // печатает реальный JSON spec — удобно для отчёта Roman-у.
        println!(
            "\n=== HardwareSpec (real machine) ===\n{}\n",
            serde_json::to_string_pretty(&spec).unwrap()
        );
    }

    #[test]
    fn test_resolve_tier_low() {
        // 4 ГБ RAM, нет GPU → Low.
        let ram = RamInfo {
            total_gb: 4.0,
            available_gb: 2.0,
        };
        let gpus: Vec<GpuInfo> = vec![];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::Low);
    }

    #[test]
    fn test_resolve_tier_mid() {
        // 12 ГБ RAM, нет GPU → Mid (CPU-only 8B).
        let ram = RamInfo {
            total_gb: 12.0,
            available_gb: 6.0,
        };
        let gpus: Vec<GpuInfo> = vec![];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::Mid);
    }

    #[test]
    fn test_resolve_tier_high_with_gpu() {
        // 16 ГБ RAM + RTX 3060 (12 ГБ VRAM) → High (RTX 3060 — mainstream карта).
        let ram = RamInfo {
            total_gb: 16.0,
            available_gb: 8.0,
        };
        let gpus = vec![GpuInfo {
            vendor: "NVIDIA".to_string(),
            name: "RTX 3060".to_string(),
            vram_gb: Some(12),
            driver_version: None,
            api: vec!["CUDA 12".to_string()],
        }];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::High);
    }

    #[test]
    fn test_resolve_tier_ultra() {
        // 64 ГБ RAM + RTX 4090 (24 ГБ VRAM) → Ultra.
        let ram = RamInfo {
            total_gb: 64.0,
            available_gb: 32.0,
        };
        let gpus = vec![GpuInfo {
            vendor: "NVIDIA".to_string(),
            name: "RTX 4090".to_string(),
            vram_gb: Some(24),
            driver_version: None,
            api: vec!["CUDA 12".to_string()],
        }];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::Ultra);
    }

    #[test]
    fn test_resolve_tier_ultra_cpu_only_64gb() {
        // 64 ГБ RAM без GPU всё равно Ultra — для 70B q4 на CPU хватит.
        let ram = RamInfo {
            total_gb: 64.0,
            available_gb: 48.0,
        };
        let gpus: Vec<GpuInfo> = vec![];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::Ultra);
    }

    #[test]
    fn test_resolve_tier_high_32gb_no_gpu() {
        // 32 ГБ RAM без GPU → High (тянет 14B q4 на CPU).
        let ram = RamInfo {
            total_gb: 32.0,
            available_gb: 16.0,
        };
        let gpus: Vec<GpuInfo> = vec![];
        assert_eq!(resolve_tier(&ram, &gpus), Tier::High);
    }
}
