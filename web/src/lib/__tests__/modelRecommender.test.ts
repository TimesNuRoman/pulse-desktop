// SPDX-License-Identifier: Apache-2.0
// Pulse R175 — modelRecommender tests.
//
// Pure функция, никаких React/DOM. 8 тестов покрывают все ветки tier-сетки:
// Low (≤4 GB), 8 GB no-GPU, 8-16 GB (Mid), 16+ GB (High), 32+ GB VRAM
// (Ultra), unknown fallback, длина массива, формат installCommand.

import { describe, test, expect } from 'vitest';
import {
  recommendModel,
  recommendModelFromInfo,
  type HardwareSummary,
} from '../modelRecommender';

describe('recommendModel — tier branches', () => {
  test('4 GB RAM → recommends gemma3:2b', () => {
    const recs = recommendModel({ ramGb: 4, vramGb: 0 });
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs[0].name).toBe('gemma3:2b');
  });

  test('8 GB RAM, no GPU → recommends gemma3:4b', () => {
    const recs = recommendModel({ ramGb: 8, vramGb: 0 });
    // 8 GB без GPU попадает в ветку "r >= 8 && r < 16 OR v >= 4" — там
    // первая рекомендация gemma3:4b.
    expect(recs[0].name).toBe('gemma3:4b');
  });

  test('8 GB RAM + 4 GB VRAM → recommends gemma3:4b (higher confidence)', () => {
    const recs = recommendModel({ ramGb: 8, vramGb: 4 });
    expect(recs[0].name).toBe('gemma3:4b');
    // Должны быть как минимум 2 модели.
    expect(recs.length).toBeGreaterThanOrEqual(2);
  });

  test('16 GB RAM → recommends gemma3:8b', () => {
    const recs = recommendModel({ ramGb: 16, vramGb: 0 });
    expect(recs[0].name).toBe('gemma3:8b');
  });

  test('32+ GB VRAM → recommends llama3.1:70b', () => {
    const recs = recommendModel({ ramGb: 16, vramGb: 32 });
    expect(recs[0].name).toBe('llama3.1:70b-q4_K_M');
  });

  test('24 GB VRAM (RTX 4090) → still Ultra only if VRAM ≥ 32', () => {
    // 24 < 32, значит идём в High ветку.
    const recs = recommendModel({ ramGb: 32, vramGb: 24 });
    expect(recs[0].name).toBe('gemma3:8b');
  });
});

describe('recommendModel — edge cases', () => {
  test('unknown RAM + unknown VRAM → falls back to gemma3:4b (safe middle)', () => {
    const recs = recommendModel({ ramGb: null, vramGb: null });
    expect(recs.length).toBe(1);
    expect(recs[0].name).toBe('gemma3:4b');
  });

  test('returns 1-3 recommendations, never more', () => {
    // Прогоняем по сетке параметров и проверяем cap.
    const cases: HardwareSummary[] = [
      { ramGb: 1, vramGb: 0 },
      { ramGb: 4, vramGb: 0 },
      { ramGb: 8, vramGb: 0 },
      { ramGb: 12, vramGb: 4 },
      { ramGb: 16, vramGb: 0 },
      { ramGb: 32, vramGb: 8 },
      { ramGb: 64, vramGb: 24 },
      { ramGb: 16, vramGb: 32 },
      { ramGb: 64, vramGb: 80 },
    ];
    for (const c of cases) {
      const recs = recommendModel(c);
      expect(recs.length).toBeGreaterThanOrEqual(1);
      expect(recs.length).toBeLessThanOrEqual(3);
    }
  });

  test('each recommendation has installCommand starting with "ollama pull"', () => {
    const recs = recommendModel({ ramGb: 16, vramGb: 0 });
    for (const r of recs) {
      expect(r.installCommand).toMatch(/^ollama pull \S+$/);
      // Имя в installCommand должно совпадать с name.
      expect(r.installCommand).toBe(`ollama pull ${r.name}`);
    }
  });
});

describe('recommendModelFromInfo — web-side adapter', () => {
  test('adapts HardwareInfo.ram number to summary', () => {
    const recs = recommendModelFromInfo({
      cpu: { cores: 8, model: 'unknown' },
      ram: 8,
      gpu: null,
      os: 'Linux',
      disk: 'unknown',
      screen: { width: 1920, height: 1080, dpi: 1 },
      language: 'en-US',
    });
    expect(recs.length).toBeGreaterThanOrEqual(1);
    expect(recs[0].name).toBeTruthy();
  });

  test('handles ram="unknown" string', () => {
    const recs = recommendModelFromInfo({
      cpu: { cores: 'unknown', model: 'unknown' },
      ram: 'unknown',
      gpu: null,
      os: 'unknown',
      disk: 'unknown',
      screen: { width: 0, height: 0, dpi: 1 },
      language: 'unknown',
    });
    // null/unknown → safe default
    expect(recs.length).toBe(1);
    expect(recs[0].name).toBe('gemma3:4b');
  });
});
