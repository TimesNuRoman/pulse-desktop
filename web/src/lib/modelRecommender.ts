// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — model recommender.
//
// Pure функция: на основе (RAM, VRAM) возвращает 1-3 рекомендации Ollama-модели.
// Логика подобрана под актуальные модели Ollama 2025-2026 + q4 квантизацию.
// Никаких side-effects, никаких API-вызовов. Полностью детерминирована.
//
// Используется в Settings → About → «Recommended models» (R175).
// Параллельная логика в Rust: `hardware::detect::resolve_tier` (Tier enum),
// но тут мы возвращаем список имён моделей, а не один Tier.

import type { HardwareInfo } from './hardwareDetector';

export interface ModelRecommendation {
  /** Ollama tag, например "gemma3:4b". */
  name: string;
  /** Примерный размер VRAM/RAM в ГБ. */
  vram: number;
  /** Короткое описание назначения ("fast chat on CPU", "balanced 8B on GPU"). */
  bestFor: string;
  /** Готовая команда для терминала. */
  installCommand: string;
}

/** Упрощённый input для recommender-а — pure функция.
 *  В UI вызывается через `recommendModelFromInfo()` (ниже), которая сама
 *  достаёт RAM/VRAM из `HardwareInfo` / `HardwareSpec`. */
export interface HardwareSummary {
  /** RAM в ГБ. null = неизвестно (фронт не получил данных). */
  ramGb: number | null;
  /** Видеопамять в ГБ. null = неизвестно (MVP Rust gpus пустой + WebGL не
   *  сообщает VRAM). 0 = точно нет GPU (integrated без дискретной карты). */
  vramGb: number | null;
}

/** Сама рекомендация. Возвращает 1-3 модели, отсортированные от «лучшего
 *  выбора» (первая) к «запасному» (последняя). */
export function recommendModel(hw: HardwareSummary): ModelRecommendation[] {
  const ram = hw.ramGb;
  const vram = hw.vramGb;
  // Если ни RAM, ни VRAM неизвестны — safe middle: gemma3:4b. Это то, что
  // 95% пользователей могут запустить (CPU-only, 8B q4 требует меньше 4 ГБ).
  if (ram === null && vram === null) {
    return [defaultRec()];
  }
  const v = vram ?? 0;
  const r = ram ?? 0;
  // Ultra: 32+ GB VRAM → llama3.1:70b q4. На CPU 70b не влезет, нужно GPU.
  if (v >= 32) {
    return [
      rec('llama3.1:70b-q4_K_M', 40, 'топ-модель на мощной GPU (≈40 ГБ VRAM)'),
      rec('llama3.1:8b', 5, 'быстрый fallback'),
      rec('mistral:7b', 5, 'fallback для tool-use'),
    ];
  }
  // High: 16+ GB RAM ИЛИ 8+ GB VRAM → 8B модели.
  if (r >= 16 || v >= 8) {
    return [
      rec('gemma3:8b', 6, 'сбалансированный 8B на GPU'),
      rec('llama3.1:8b', 5, '8B от Meta, хорош для tool-use'),
      rec('mistral:7b', 5, 'лёгкий 7B, быстрый'),
    ];
  }
  // Mid: 8-16 GB RAM, ИЛИ 4-8 GB VRAM → 3-4B модели.
  if ((r >= 8 && r < 16) || (v >= 4 && v < 8)) {
    return [
      rec('gemma3:4b', 3.3, 'balanced 4B, vision + text'),
      rec('llama3.2:3b', 2.0, 'лёгкий 3B от Meta'),
      rec('mistral:7b', 5.0, '7B fallback (если влезает в RAM)'),
    ];
  }
  // 8 GB RAM, без GPU → 3-4B.
  if (r >= 8) {
    return [
      rec('gemma3:4b', 3.3, 'balanced 4B на CPU'),
      rec('qwen2.5:3b', 2.0, 'лёгкий 3B с неплохим reasoning'),
    ];
  }
  // Low: 4 GB RAM или меньше → 1.5-2B модели.
  return [
    rec('gemma3:2b', 1.6, 'минимальный 2B для слабых машин'),
    rec('qwen2.5:1.5b', 1.0, 'очень лёгкий 1.5B'),
  ];
}

/** Удобный wrapper: берёт `HardwareInfo` (web) и достаёт RAM/VRAM.
 *  У `HardwareInfo` нет VRAM (WebGL не сообщает), поэтому передаём null. */
export function recommendModelFromInfo(info: HardwareInfo): ModelRecommendation[] {
  return recommendModel({
    ramGb: typeof info.ram === 'number' ? info.ram : null,
    vramGb: null, // WebGL renderer не содержит VRAM
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

function rec(name: string, vram: number, bestFor: string): ModelRecommendation {
  return { name, vram, bestFor, installCommand: `ollama pull ${name}` };
}

function defaultRec(): ModelRecommendation {
  return rec('gemma3:4b', 3.3, 'safe default — 4B, vision + text');
}
